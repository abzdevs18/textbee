package com.vernu.sms.outbox

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Durable on-phone outbox. Every SMS command the server hands to this phone is
 * written here before anything else happens, so a killed process, a deferred
 * job or a duplicate push can no longer lose or double-send a message.
 * Decisions live in [OutboxPolicy]; this class only persists them.
 */
class OutboxStore private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "gabay_sms_outbox.db"
        private const val DB_VERSION = 1
        private const val TABLE = "outbox"

        private const val TERMINAL_RETENTION_MS = 3L * 24 * 60 * 60 * 1000
        private const val STALE_ACTIVE_RETENTION_MS = 24L * 60 * 60 * 1000
        private const val MAX_ROWS = 3000

        private val ACTIVE_STATES = arrayOf(LocalState.QUEUED.name, LocalState.SUBMITTED.name)
        private val STALE_CANDIDATE_STATES = arrayOf(
            LocalState.QUEUED.name, LocalState.SUBMITTED.name, LocalState.LAPSED.name
        )
        private val TERMINAL_STATES = arrayOf(
            LocalState.SENT.name, LocalState.DELIVERED.name,
            LocalState.FAILED.name, LocalState.EXPIRED.name
        )

        @Volatile
        private var instance: OutboxStore? = null

        @JvmStatic
        fun get(context: Context): OutboxStore =
            instance ?: synchronized(this) {
                instance ?: OutboxStore(context).also { instance = it }
            }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE (
                local_id TEXT PRIMARY KEY NOT NULL,
                sms_id TEXT NOT NULL,
                batch_id TEXT,
                recipient TEXT NOT NULL,
                message TEXT NOT NULL,
                sim_subscription_id INTEGER,
                attempt INTEGER NOT NULL DEFAULT 1,
                send_seq INTEGER NOT NULL DEFAULT 0,
                expires_at_ms INTEGER,
                issued_at_ms INTEGER,
                lease_until_ms INTEGER,
                received_at_ms INTEGER NOT NULL,
                received_elapsed_ms INTEGER NOT NULL,
                state TEXT NOT NULL,
                parts_total INTEGER NOT NULL DEFAULT 0,
                parts_sent_mask INTEGER NOT NULL DEFAULT 0,
                parts_failed_mask INTEGER NOT NULL DEFAULT 0,
                parts_delivered_mask INTEGER NOT NULL DEFAULT 0,
                submitted_at_ms INTEGER,
                completed_at_ms INTEGER,
                requested_sim_id INTEGER,
                resolved_sim_id INTEGER,
                error_code TEXT,
                error_message TEXT,
                source TEXT,
                updated_at_ms INTEGER NOT NULL
            )
            """.trimIndent()
        )
        // rowid keeps the original arrival order, even across re-issues.
        db.execSQL("CREATE INDEX idx_outbox_state ON $TABLE(state)")
        db.execSQL("CREATE INDEX idx_outbox_sms_id ON $TABLE(sms_id)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1 is the only schema so far.
    }

    /** Records a command, deciding how a duplicate delivery must be treated. */
    @Synchronized
    fun accept(cmd: IncomingCommand, nowMs: Long, nowElapsedMs: Long): AcceptResult {
        val db = writableDatabase
        val existing = find(db, cmd.localId)
        val plan = OutboxPolicy.decideAccept(existing, cmd, nowMs)
        when (plan.action) {
            AcceptAction.INSERT -> db.insertOrThrow(TABLE, null, ContentValues().apply {
                put("local_id", cmd.localId)
                put("sms_id", cmd.smsId)
                put("batch_id", cmd.batchId)
                put("recipient", cmd.recipient)
                put("message", cmd.message)
                putNullable("sim_subscription_id", cmd.simSubscriptionId)
                put("attempt", cmd.attempt)
                put("send_seq", 0)
                putNullable("expires_at_ms", cmd.expiresAtMs)
                putNullable("issued_at_ms", cmd.issuedAtMs)
                putNullable("lease_until_ms", cmd.leaseUntilMs)
                put("received_at_ms", nowMs)
                put("received_elapsed_ms", nowElapsedMs)
                put("state", LocalState.QUEUED.name)
                put("source", cmd.source)
                put("updated_at_ms", nowMs)
            })
            AcceptAction.REFRESH -> refreshIssue(db, cmd, nowMs, nowElapsedMs, requeue = false)
            AcceptAction.REQUEUE -> refreshIssue(db, cmd, nowMs, nowElapsedMs, requeue = true)
            AcceptAction.BUMP_ATTEMPT -> db.update(TABLE, ContentValues().apply {
                put("attempt", cmd.attempt)
                put("updated_at_ms", nowMs)
            }, "local_id = ?", arrayOf(cmd.localId))
            AcceptAction.NONE -> Unit
        }
        val result = plan.result
        // Re-reports must carry the attempt the server currently expects.
        return if (result is AcceptResult.Rereport && plan.action == AcceptAction.BUMP_ATTEMPT) {
            AcceptResult.Rereport(find(db, cmd.localId) ?: result.entry)
        } else {
            result
        }
    }

    @Synchronized
    fun nextQueued(): OutboxEntry? {
        val db = readableDatabase
        db.query(
            TABLE, null, "state = ?", arrayOf(LocalState.QUEUED.name),
            null, null, "rowid ASC", "1"
        ).use { cursor ->
            return if (cursor.moveToFirst()) read(cursor) else null
        }
    }

    /**
     * Moves a queued entry to SUBMITTED *before* the radio call, so a crash
     * between the two can never cause a second send of the same attempt.
     * @return the new send sequence, or null if the entry is no longer queued.
     */
    @Synchronized
    fun markSubmitted(
        localId: String,
        partsTotal: Int,
        requestedSimId: Int?,
        resolvedSimId: Int?,
        nowMs: Long
    ): Int? {
        val db = writableDatabase
        val entry = find(db, localId) ?: return null
        if (entry.state != LocalState.QUEUED) return null
        val sendSeq = entry.sendSeq + 1
        db.update(TABLE, ContentValues().apply {
            put("state", LocalState.SUBMITTED.name)
            put("send_seq", sendSeq)
            put("parts_total", partsTotal.coerceAtLeast(1))
            put("parts_sent_mask", 0L)
            put("parts_failed_mask", 0L)
            put("parts_delivered_mask", 0L)
            put("submitted_at_ms", nowMs)
            putNull("completed_at_ms")
            putNullable("requested_sim_id", requestedSimId)
            putNullable("resolved_sim_id", resolvedSimId)
            putNull("error_code")
            putNull("error_message")
            put("updated_at_ms", nowMs)
        }, "local_id = ?", arrayOf(localId))
        return sendSeq
    }

    /** Ends a queued or submitted entry without a radio outcome (refusal, exception). */
    @Synchronized
    fun finish(
        localId: String,
        state: LocalState,
        errorCode: String?,
        errorMessage: String?,
        nowMs: Long
    ): OutboxEntry? {
        val db = writableDatabase
        val entry = find(db, localId) ?: return null
        if (entry.state.isTerminal) return null
        db.update(TABLE, ContentValues().apply {
            put("state", state.name)
            put("error_code", errorCode)
            put("error_message", errorMessage)
            put("completed_at_ms", nowMs)
            put("updated_at_ms", nowMs)
        }, "local_id = ?", arrayOf(localId))
        return find(db, localId)
    }

    /** Parks a queued entry whose server lease ran out; nothing is reported. */
    @Synchronized
    fun markLapsed(localId: String, nowMs: Long): Boolean {
        val db = writableDatabase
        return db.update(TABLE, ContentValues().apply {
            put("state", LocalState.LAPSED.name)
            put("updated_at_ms", nowMs)
        }, "local_id = ? AND state = ?", arrayOf(localId, LocalState.QUEUED.name)) > 0
    }

    /** Aggregates per-part SENT callbacks into one outcome for the whole SMS. */
    @Synchronized
    fun recordSentPart(
        localId: String,
        sendSeq: Int,
        partIndex: Int,
        partCount: Int,
        ok: Boolean,
        errorCode: String?,
        errorMessage: String?,
        nowMs: Long
    ): PartOutcome {
        val db = writableDatabase
        val entry = find(db, localId) ?: return PartOutcome.Ignored
        val plan = OutboxPolicy.decideSentPart(entry, sendSeq, partIndex, partCount, ok)
            ?: return PartOutcome.Ignored

        db.update(TABLE, ContentValues().apply {
            put("parts_total", plan.expected)
            put("parts_sent_mask", plan.sentMask)
            put("parts_failed_mask", plan.failedMask)
            put("updated_at_ms", nowMs)
            if (plan.recordError) {
                put("error_code", errorCode)
                put("error_message", errorMessage)
            }
            plan.finalState?.let {
                put("state", it.name)
                put("completed_at_ms", nowMs)
            }
        }, "local_id = ?", arrayOf(localId))
        val updated = find(db, localId) ?: return PartOutcome.Ignored
        return if (plan.finalState != null) PartOutcome.Completed(updated) else PartOutcome.Pending
    }

    /** Aggregates per-part delivery reports; completes once every part is delivered. */
    @Synchronized
    fun recordDeliveredPart(
        localId: String,
        sendSeq: Int,
        partIndex: Int,
        partCount: Int,
        nowMs: Long
    ): PartOutcome {
        val db = writableDatabase
        val entry = find(db, localId) ?: return PartOutcome.Ignored
        if (entry.sendSeq != sendSeq) return PartOutcome.Ignored
        if (entry.state != LocalState.SENT && entry.state != LocalState.SUBMITTED) {
            return PartOutcome.Ignored
        }

        val expected = PartMath.expected(entry.partsTotal, partCount)
        val deliveredMask = entry.partsDeliveredMask or PartMath.bit(partIndex)
        val complete = entry.state == LocalState.SENT &&
            PartMath.isComplete(deliveredMask, expected)

        db.update(TABLE, ContentValues().apply {
            put("parts_delivered_mask", deliveredMask)
            put("updated_at_ms", nowMs)
            if (complete) {
                put("state", LocalState.DELIVERED.name)
                put("completed_at_ms", nowMs)
            }
        }, "local_id = ?", arrayOf(localId))
        val updated = find(db, localId) ?: return PartOutcome.Ignored
        return if (complete) PartOutcome.Completed(updated) else PartOutcome.Pending
    }

    @Synchronized
    fun get(localId: String): OutboxEntry? = find(readableDatabase, localId)

    /** Latest local entry per server SMS id, for the Messages screen. */
    @Synchronized
    fun snapshotsFor(smsIds: Collection<String>): Map<String, OutboxEntry> {
        val ids = smsIds.filter { it.isNotBlank() }.distinct()
        if (ids.isEmpty()) return emptyMap()
        val db = readableDatabase
        val result = HashMap<String, OutboxEntry>()
        ids.chunked(400).forEach { chunk ->
            val placeholders = chunk.joinToString(",") { "?" }
            db.query(
                TABLE, null, "sms_id IN ($placeholders)", chunk.toTypedArray(),
                null, null, "updated_at_ms ASC"
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val entry = read(cursor)
                    val current = result[entry.smsId]
                    // Prefer the primary recipient row (local_id == sms_id).
                    if (current == null || entry.localId == entry.smsId || current.localId != current.smsId) {
                        result[entry.smsId] = entry
                    }
                }
            }
        }
        return result
    }

    @Synchronized
    fun countQueued(): Int {
        val db = readableDatabase
        db.rawQuery(
            "SELECT COUNT(*) FROM $TABLE WHERE state = ?", arrayOf(LocalState.QUEUED.name)
        ).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    /** Commands this phone holds that are not finished yet (queued or on the radio). */
    @Synchronized
    fun countActive(): Int {
        val db = readableDatabase
        db.rawQuery(
            "SELECT COUNT(*) FROM $TABLE WHERE state IN (?, ?)", ACTIVE_STATES
        ).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    @Synchronized
    fun prune(nowMs: Long) {
        val db = writableDatabase
        db.delete(
            TABLE,
            "state IN (?, ?, ?, ?) AND updated_at_ms < ?",
            TERMINAL_STATES + (nowMs - TERMINAL_RETENTION_MS).toString()
        )
        db.delete(
            TABLE,
            "state IN (?, ?, ?) AND updated_at_ms < ?",
            STALE_CANDIDATE_STATES + (nowMs - STALE_ACTIVE_RETENTION_MS).toString()
        )
        db.execSQL(
            "DELETE FROM $TABLE WHERE local_id IN (" +
                "SELECT local_id FROM $TABLE WHERE state IN (?, ?, ?, ?) " +
                "ORDER BY updated_at_ms DESC LIMIT -1 OFFSET $MAX_ROWS)",
            arrayOf<Any>(*TERMINAL_STATES)
        )
    }

    private fun refreshIssue(
        db: SQLiteDatabase,
        cmd: IncomingCommand,
        nowMs: Long,
        nowElapsedMs: Long,
        requeue: Boolean
    ) {
        db.update(TABLE, ContentValues().apply {
            put("attempt", cmd.attempt)
            putNullable("expires_at_ms", cmd.expiresAtMs)
            putNullable("issued_at_ms", cmd.issuedAtMs)
            putNullable("lease_until_ms", cmd.leaseUntilMs)
            putNullable("sim_subscription_id", cmd.simSubscriptionId)
            put("message", cmd.message)
            put("recipient", cmd.recipient)
            // Receipt time anchors the server-clock estimate for this issue.
            put("received_at_ms", nowMs)
            put("received_elapsed_ms", nowElapsedMs)
            put("source", cmd.source)
            put("updated_at_ms", nowMs)
            if (requeue) {
                put("state", LocalState.QUEUED.name)
                put("parts_sent_mask", 0L)
                put("parts_failed_mask", 0L)
                put("parts_delivered_mask", 0L)
                putNull("submitted_at_ms")
                putNull("completed_at_ms")
                putNull("error_code")
                putNull("error_message")
            }
        }, "local_id = ?", arrayOf(cmd.localId))
    }

    private fun find(db: SQLiteDatabase, localId: String): OutboxEntry? {
        db.query(TABLE, null, "local_id = ?", arrayOf(localId), null, null, null, "1").use { cursor ->
            return if (cursor.moveToFirst()) read(cursor) else null
        }
    }

    private fun read(c: Cursor): OutboxEntry = OutboxEntry(
        localId = c.string("local_id") ?: "",
        smsId = c.string("sms_id") ?: "",
        batchId = c.string("batch_id"),
        recipient = c.string("recipient") ?: "",
        message = c.string("message") ?: "",
        simSubscriptionId = c.intOrNull("sim_subscription_id"),
        attempt = c.intOrNull("attempt") ?: 1,
        sendSeq = c.intOrNull("send_seq") ?: 0,
        expiresAtMs = c.longOrNull("expires_at_ms"),
        issuedAtMs = c.longOrNull("issued_at_ms"),
        leaseUntilMs = c.longOrNull("lease_until_ms"),
        receivedAtMs = c.longOrNull("received_at_ms") ?: 0L,
        receivedElapsedMs = c.longOrNull("received_elapsed_ms") ?: 0L,
        state = LocalState.parse(c.string("state")),
        partsTotal = c.intOrNull("parts_total") ?: 0,
        partsSentMask = c.longOrNull("parts_sent_mask") ?: 0L,
        partsFailedMask = c.longOrNull("parts_failed_mask") ?: 0L,
        partsDeliveredMask = c.longOrNull("parts_delivered_mask") ?: 0L,
        submittedAtMs = c.longOrNull("submitted_at_ms"),
        completedAtMs = c.longOrNull("completed_at_ms"),
        requestedSimId = c.intOrNull("requested_sim_id"),
        resolvedSimId = c.intOrNull("resolved_sim_id"),
        errorCode = c.string("error_code"),
        errorMessage = c.string("error_message"),
        updatedAtMs = c.longOrNull("updated_at_ms") ?: 0L
    )

    private fun Cursor.string(column: String): String? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getString(index)
    }

    private fun Cursor.intOrNull(column: String): Int? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getInt(index)
    }

    private fun Cursor.longOrNull(column: String): Long? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getLong(index)
    }

    private fun ContentValues.putNullable(key: String, value: Int?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private fun ContentValues.putNullable(key: String, value: Long?) {
        if (value == null) putNull(key) else put(key, value)
    }
}
