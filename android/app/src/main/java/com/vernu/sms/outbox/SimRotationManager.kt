package com.vernu.sms.outbox

import android.Manifest
import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.helpers.HeartbeatManager
import com.vernu.sms.helpers.SharedPreferenceHelper

/**
 * Android side of [SimRotationPolicy]: reads usable SIMs (cached briefly to avoid
 * per-second Binder IPC), persists per-SIM pacing/in-flight state (so restarts
 * never burst), and keeps SIM health in memory (so restarts restore paused SIMs).
 */
object SimRotationManager {
    private const val TAG = "SimRotation"

    private const val PREF_LAST_SIM = "SIM_ROTATION_LAST_SIM"
    private const val PREF_LAST_SUBMIT_ANY_MS = "SIM_ROTATION_LAST_SUBMIT_ANY_MS"
    private const val PREF_LAST_SUBMIT_BY_SIM = "SIM_ROTATION_LAST_SUBMIT_BY_SIM"
    private const val PREF_IN_FLIGHT_BY_SIM = "SIM_ROTATION_IN_FLIGHT_BY_SIM"

    // Legacy keys (<= 2.8.27): migrated cleanly on first load after upgrade.
    private const val LEGACY_PREF_LAST_CONFIRM_ANY_MS = "SIM_ROTATION_LAST_CONFIRM_ANY_MS"
    private const val LEGACY_PREF_LAST_CONFIRM_BY_SIM = "SIM_ROTATION_LAST_CONFIRM_BY_SIM"
    private const val LEGACY_PREF_IN_FLIGHT = "SIM_ROTATION_IN_FLIGHT"

    private const val NO_SIM = Int.MIN_VALUE

    /** Recently timed-out sends, so a late callback for one is not counted twice. */
    private const val MAX_TIMED_OUT_KEYS = 50

    /** Cache active usable SIMs briefly so 1s in-flight polls don't hammer SubscriptionManager IPC. */
    private const val ACTIVE_SIMS_CACHE_TTL_MS = 15_000L

    private val health = SimHealth()
    private val timedOut = LinkedHashMap<String, Int>()
    private var state: SimRotationState? = null
    private var cachedActiveSims: List<Int>? = null
    private var cachedActiveSimsAtElapsedMs: Long = 0L

    data class SimStatus(val sim: Int, val paused: Boolean, val failureStreak: Int)

    /** Result of scanning all currently in-flight sends for timeouts / partial-confirm grace. */
    data class TimeoutCheckResult(
        val resolved: List<ResolvedTimeout>,
        /** Delay until the next in-flight check is needed, or null when nothing remains in flight. */
        val nextCheckDelayMs: Long?
    )

    @JvmStatic
    fun isEnabled(context: Context): Boolean =
        SharedPreferenceHelper.getSharedPreferenceBoolean(
            context, AppConstants.SHARED_PREFS_SIM_ROTATION_ENABLED_KEY,
            AppConstants.DEFAULT_SIM_ROTATION_ENABLED
        )

    /**
     * Checks every in-flight send (without querying SubscriptionManager IPC) for hard
     * timeouts (60s), multipart partial-confirmation grace (20s), or stale rows that
     * already completed out of band.
     *
     * Callers must reconcile [TimeoutCheckResult.resolved] against [OutboxStore] and
     * [StatusReporter] after this returns (outside the SimRotationManager lock).
     */
    fun resolveExpiredInFlight(
        context: Context,
        nowMs: Long,
        lookupEntry: (String) -> OutboxEntry?
    ): TimeoutCheckResult {
        var triggerHeartbeat = false
        val result = synchronized(this) {
            var current = load(context)
            if (current.inFlightBySim.isEmpty()) {
                return@synchronized TimeoutCheckResult(emptyList(), null)
            }

            val resolved = ArrayList<ResolvedTimeout>()
            var minRemainingMs: Long? = null
            var stateChanged = false

            val flights = current.inFlightBySim.values.sortedBy { it.submittedAtMs }
            for (flight in flights) {
                val parsed = SimRotationPolicy.parseFlightKey(flight.key)
                val localId = parsed?.first ?: flight.key
                val sendSeq = parsed?.second ?: -1
                val entry = if (parsed != null) lookupEntry(localId) else null
                val (kind, remainingMs) = SimRotationPolicy.evaluateInFlightTimeout(flight, entry, nowMs)

                if (kind == InFlightTimeoutKind.NONE) {
                    minRemainingMs = if (minRemainingMs == null) remainingMs else minOf(minRemainingMs, remainingMs)
                    continue
                }

                current = SimRotationPolicy.finished(current, flight.sim)
                stateChanged = true

                if (kind != InFlightTimeoutKind.ALREADY_FINISHED) {
                    val outcome = when (kind) {
                        InFlightTimeoutKind.PARTIAL_CONFIRMED -> SimOutcome.NEUTRAL
                        InFlightTimeoutKind.PARTIAL_FAILED -> SimRotationPolicy.outcomeOfError(entry?.errorCode)
                        InFlightTimeoutKind.UNCONFIRMED -> SimOutcome.SIM_FAILURE
                        else -> SimOutcome.NEUTRAL
                    }
                    Log.w(
                        TAG,
                        "In-flight ${flight.key} on SIM ${flight.sim} resolved as $kind ($outcome)"
                    )
                    rememberTimedOut(flight)
                    if (recordHealthLocked(flight.sim, outcome)) {
                        triggerHeartbeat = true
                    }
                }
                resolved.add(ResolvedTimeout(flight, kind, localId, sendSeq))
            }

            if (stateChanged) save(context, current)

            val nextCheckDelayMs = minRemainingMs?.let {
                minOf(it, SimRotationPolicy.CONFIRM_POLL_MS).coerceAtLeast(1L)
            }
            TimeoutCheckResult(resolved, nextCheckDelayMs)
        }

        if (triggerHeartbeat) {
            HeartbeatManager.triggerHeartbeat(context.applicationContext)
        }
        return result
    }

    /**
     * Decides whether the next queued SMS may go now, and on which SIM.
     * Caller should run [resolveExpiredInFlight] first so expired/partial sends are reconciled.
     */
    @Synchronized
    fun decideNext(context: Context, nowMs: Long, nextInFlightCheckMs: Long? = null): SimDecision {
        val current = load(context)
        val decision = SimRotationPolicy.decide(current, usableSims(context), nowMs)
        if (decision is SimDecision.Wait && nextInFlightCheckMs != null) {
            return SimDecision.Wait(minOf(decision.delayMs, nextInFlightCheckMs).coerceAtLeast(1L))
        }
        return decision
    }

    /** The SMS is about to be handed to the radio on [sim]. */
    @Synchronized
    fun onStarted(context: Context, localId: String, sendSeq: Int, sim: Int, nowMs: Long) {
        val flight = SimInFlight(keyOf(localId, sendSeq), sim, nowMs)
        save(context, SimRotationPolicy.started(load(context), flight))
    }

    /**
     * The radio finished a send (SENT/DELIVERED callback aggregated over all parts,
     * or an exception at hand-off). Unknown sends (rotation off, older app version) are ignored.
     */
    fun onFinished(context: Context, localId: String, sendSeq: Int, outcome: SimOutcome, nowMs: Long) {
        val triggerHeartbeat = synchronized(this) {
            val key = keyOf(localId, sendSeq)
            val current = load(context)
            val flight = current.inFlightBySim.values.firstOrNull { it.key == key }
            if (flight != null) {
                save(context, SimRotationPolicy.finished(current, flight.sim))
                return@synchronized recordHealthLocked(flight.sim, outcome)
            }
            // Already counted as a timeout: a late success still proves the SIM works.
            val lateSim = timedOut[key] ?: return@synchronized false
            if (outcome == SimOutcome.SUCCESS) {
                return@synchronized recordHealthLocked(lateSim, outcome)
            }
            false
        }
        if (triggerHeartbeat) {
            HeartbeatManager.triggerHeartbeat(context.applicationContext)
        }
    }

    /** A send that failed before it got a send sequence (e.g. SmsManager rejected/threw). */
    fun onFailedBeforeStart(context: Context, sim: Int, outcome: SimOutcome, nowMs: Long) {
        val triggerHeartbeat = synchronized(this) {
            val current = load(context)
            save(context, SimRotationPolicy.failedBeforeStart(current, sim, nowMs))
            recordHealthLocked(sim, outcome)
        }
        if (triggerHeartbeat) {
            HeartbeatManager.triggerHeartbeat(context.applicationContext)
        }
    }

    /** True while at least one SIM has an unconfirmed send in flight. */
    @Synchronized
    fun hasInFlight(context: Context): Boolean = load(context).inFlightBySim.isNotEmpty()

    /** True when Alternate SIM is enabled and every active SIM is paused. */
    @Synchronized
    fun areAllSimsPaused(context: Context): Boolean =
        isEnabled(context) && usableSims(context).isEmpty()

    /**
     * Clears stale in-flight entries and SIM cache when the user toggles Alternate SIM
     * in Settings so mode transitions take effect immediately.
     */
    @Synchronized
    fun resetForToggle(context: Context) {
        cachedActiveSims = null
        cachedActiveSimsAtElapsedMs = 0L
        val current = load(context)
        if (current.inFlightBySim.isNotEmpty()) {
            save(context, current.copy(inFlightBySim = emptyMap()))
        }
    }

    /** Health of every usable SIM the phone currently has, for the dashboard. */
    @Synchronized
    fun statuses(context: Context): List<SimStatus> =
        activeSims(context, forceRefresh = true).map {
            SimStatus(it, health.isPaused(it), health.failureStreak(it))
        }

    /** Seconds between SMS this phone currently sends at, for the server's lease sizing. */
    @Synchronized
    fun effectiveSendDelaySeconds(context: Context): Int =
        if (usableSims(context).size >= 2) {
            (SimRotationPolicy.DEVICE_GAP_MS / 1000).toInt()
        } else {
            (SimRotationPolicy.SIM_GAP_MS / 1000).toInt()
        }

    /** subscriptionId to pass to SmsManager; null means the phone's default SMS SIM. */
    @JvmStatic
    fun subscriptionIdFor(sim: Int): Int? = if (sim == SimRotationPolicy.DEFAULT_SIM) null else sim

    private fun usableSims(context: Context): List<Int> =
        activeSims(context, forceRefresh = false).filterNot { health.isPaused(it) }

    /** Usable active SIMs in slot order; cached briefly to avoid per-second Binder IPC. */
    private fun activeSims(context: Context, forceRefresh: Boolean): List<Int> {
        val nowElapsed = SystemClock.elapsedRealtime()
        val cached = cachedActiveSims
        if (!forceRefresh && cached != null && (nowElapsed - cachedActiveSimsAtElapsedMs) in 0 until ACTIVE_SIMS_CACHE_TTL_MS) {
            return cached
        }
        val listed = if (TextBeeUtils.isPermissionGranted(context, Manifest.permission.READ_PHONE_STATE)) {
            try {
                TextBeeUtils.getUsableSimSlots(context)
                    .sortedWith(
                        compareBy<android.telephony.SubscriptionInfo> { it.simSlotIndex }
                            .thenBy { it.subscriptionId }
                    )
                    .map { it.subscriptionId }
                    .distinct()
            } catch (e: Exception) {
                Log.e(TAG, "Unable to read usable SIMs: ${e.message}", e)
                emptyList()
            }
        } else {
            emptyList()
        }
        val resolved = listed.ifEmpty { listOf(SimRotationPolicy.DEFAULT_SIM) }
        cachedActiveSims = resolved
        cachedActiveSimsAtElapsedMs = nowElapsed
        return resolved
    }

    /** @return true when this outcome newly paused [sim] (caller triggers expedited heartbeat). */
    private fun recordHealthLocked(sim: Int, outcome: SimOutcome): Boolean {
        if (outcome == SimOutcome.SIM_FAILURE) {
            // Re-probe SIM state on next decide in case the slot was disabled/removed.
            cachedActiveSims = null
        }
        if (health.record(sim, outcome)) {
            Log.w(TAG, "SIM $sim paused after ${SimRotationPolicy.FAILURE_LIMIT} failed SMS in a row; it returns when the app restarts")
            cachedActiveSims = null
            return true
        }
        return false
    }

    private fun rememberTimedOut(flight: SimInFlight) {
        timedOut[flight.key] = flight.sim
        while (timedOut.size > MAX_TIMED_OUT_KEYS) {
            timedOut.remove(timedOut.keys.first())
        }
    }

    private fun keyOf(localId: String, sendSeq: Int) = "$localId#$sendSeq"

    private fun parseFlightLine(raw: String): SimInFlight? {
        // key|sim|submittedAt — the key may itself contain anything but the last two fields.
        val atSep = raw.lastIndexOf('|')
        if (atSep <= 0) return null
        val simSep = raw.lastIndexOf('|', atSep - 1)
        if (simSep <= 0) return null
        val sim = raw.substring(simSep + 1, atSep).toIntOrNull() ?: return null
        val at = raw.substring(atSep + 1).toLongOrNull() ?: return null
        return SimInFlight(raw.substring(0, simSep), sim, at)
    }

    private fun parseBySimMap(raw: String?): Map<Int, Long> =
        raw.orEmpty()
            .split(',')
            .mapNotNull { pair ->
                val parts = pair.split(':')
                val sim = parts.getOrNull(0)?.toIntOrNull()
                val at = parts.getOrNull(1)?.toLongOrNull()
                if (sim != null && at != null) sim to at else null
            }
            .toMap()

    private fun load(context: Context): SimRotationState {
        state?.let { return it }
        val lastSim = SharedPreferenceHelper.getSharedPreferenceInt(context, PREF_LAST_SIM, NO_SIM)
            .takeIf { it != NO_SIM }

        // Backwards-compatible migration from <= 2.8.27 confirmation-timestamp keys.
        val lastAny = (SharedPreferenceHelper.getSharedPreferenceString(context, PREF_LAST_SUBMIT_ANY_MS, null)
            ?: SharedPreferenceHelper.getSharedPreferenceString(context, LEGACY_PREF_LAST_CONFIRM_ANY_MS, null))
            ?.toLongOrNull()

        val rawBySim = SharedPreferenceHelper.getSharedPreferenceString(context, PREF_LAST_SUBMIT_BY_SIM, null)
            ?: SharedPreferenceHelper.getSharedPreferenceString(context, LEGACY_PREF_LAST_CONFIRM_BY_SIM, null)
        val bySim = parseBySimMap(rawBySim)

        val rawInFlight = SharedPreferenceHelper.getSharedPreferenceString(context, PREF_IN_FLIGHT_BY_SIM, null)
        val inFlightBySim = if (rawInFlight != null) {
            rawInFlight.split('\n')
                .mapNotNull { line -> line.takeIf { it.isNotBlank() }?.let(::parseFlightLine) }
                .associateBy { it.sim }
        } else {
            val legacy = SharedPreferenceHelper.getSharedPreferenceString(context, LEGACY_PREF_IN_FLIGHT, null)
                ?.let(::parseFlightLine)
            if (legacy != null) mapOf(legacy.sim to legacy) else emptyMap()
        }

        return SimRotationState(lastSim, lastAny, bySim, inFlightBySim).also { state = it }
    }

    private fun save(context: Context, next: SimRotationState) {
        state = next
        if (next.lastSim != null) {
            SharedPreferenceHelper.setSharedPreferenceInt(context, PREF_LAST_SIM, next.lastSim)
        } else {
            SharedPreferenceHelper.clearSharedPreference(context, PREF_LAST_SIM)
        }
        if (next.lastSubmitAnyMs != null) {
            SharedPreferenceHelper.setSharedPreferenceString(
                context, PREF_LAST_SUBMIT_ANY_MS, next.lastSubmitAnyMs.toString()
            )
        } else {
            SharedPreferenceHelper.clearSharedPreference(context, PREF_LAST_SUBMIT_ANY_MS)
        }
        SharedPreferenceHelper.setSharedPreferenceString(
            context, PREF_LAST_SUBMIT_BY_SIM,
            next.lastSubmitBySim.entries.joinToString(",") { "${it.key}:${it.value}" }
        )
        if (next.inFlightBySim.isNotEmpty()) {
            val encoded = next.inFlightBySim.values.joinToString("\n") { flight ->
                "${flight.key.replace('\n', ' ')}|${flight.sim}|${flight.submittedAtMs}"
            }
            SharedPreferenceHelper.setSharedPreferenceString(context, PREF_IN_FLIGHT_BY_SIM, encoded)
        } else {
            SharedPreferenceHelper.clearSharedPreference(context, PREF_IN_FLIGHT_BY_SIM)
        }
        // Clean up legacy <= 2.8.27 keys once migrated.
        SharedPreferenceHelper.clearSharedPreference(context, LEGACY_PREF_LAST_CONFIRM_ANY_MS)
        SharedPreferenceHelper.clearSharedPreference(context, LEGACY_PREF_LAST_CONFIRM_BY_SIM)
        SharedPreferenceHelper.clearSharedPreference(context, LEGACY_PREF_IN_FLIGHT)
    }
}
