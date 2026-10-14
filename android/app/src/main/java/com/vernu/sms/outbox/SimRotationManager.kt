package com.vernu.sms.outbox

import android.Manifest
import android.content.Context
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.helpers.SharedPreferenceHelper

/**
 * Android side of [SimRotationPolicy]: reads the phone's SIMs, persists the
 * pacing state (so a restart never causes a burst) and keeps SIM health in
 * memory (so a restart brings paused SIMs back).
 */
object SimRotationManager {
    private const val TAG = "SimRotation"

    private const val PREF_LAST_SIM = "SIM_ROTATION_LAST_SIM"
    private const val PREF_LAST_CONFIRM_ANY_MS = "SIM_ROTATION_LAST_CONFIRM_ANY_MS"
    private const val PREF_LAST_CONFIRM_BY_SIM = "SIM_ROTATION_LAST_CONFIRM_BY_SIM"
    private const val PREF_IN_FLIGHT = "SIM_ROTATION_IN_FLIGHT"
    private const val NO_SIM = Int.MIN_VALUE

    /** Recently timed-out sends, so a late callback for one is not counted twice. */
    private const val MAX_TIMED_OUT_KEYS = 50

    private val health = SimHealth()
    private val timedOut = LinkedHashMap<String, Int>()
    private var state: SimRotationState? = null

    data class SimStatus(val sim: Int, val paused: Boolean, val failureStreak: Int)

    @JvmStatic
    fun isEnabled(context: Context): Boolean =
        SharedPreferenceHelper.getSharedPreferenceBoolean(
            context, AppConstants.SHARED_PREFS_SIM_ROTATION_ENABLED_KEY,
            AppConstants.DEFAULT_SIM_ROTATION_ENABLED
        )

    /**
     * Decides whether the next queued SMS may go now, and on which SIM.
     * [timeoutOutcome] judges an unconfirmed send from its outbox row (localId, sendSeq).
     */
    @Synchronized
    fun decide(context: Context, nowMs: Long, timeoutOutcome: (String, Int) -> SimOutcome): SimDecision {
        while (true) {
            val current = load(context)
            when (val decision = SimRotationPolicy.decide(current, usableSims(context), nowMs)) {
                is SimDecision.TimedOut -> {
                    val flight = decision.inFlight
                    val seqSep = flight.key.lastIndexOf('#')
                    val outcome = if (seqSep > 0) {
                        timeoutOutcome(
                            flight.key.substring(0, seqSep),
                            flight.key.substring(seqSep + 1).toIntOrNull() ?: -1
                        )
                    } else {
                        SimOutcome.SIM_FAILURE
                    }
                    Log.w(TAG, "No network confirmation for ${flight.key} on SIM ${flight.sim} within ${SimRotationPolicy.CONFIRM_TIMEOUT_MS / 1000}s ($outcome)")
                    rememberTimedOut(flight)
                    val confirmAt = minOf(nowMs, flight.submittedAtMs + SimRotationPolicy.CONFIRM_TIMEOUT_MS)
                    save(context, SimRotationPolicy.finished(current, flight.sim, confirmAt))
                    recordHealth(flight.sim, outcome)
                }
                else -> return decision
            }
        }
    }

    /** The SMS is about to be handed to the radio on [sim]. */
    @Synchronized
    fun onStarted(context: Context, localId: String, sendSeq: Int, sim: Int, nowMs: Long) {
        val flight = SimInFlight(keyOf(localId, sendSeq), sim, nowMs)
        save(context, SimRotationPolicy.started(load(context), flight))
    }

    /**
     * The radio finished a send (SENT callback aggregated over all parts, or an
     * exception at hand-off). Unknown sends (rotation off, older app version) are ignored.
     */
    @Synchronized
    fun onFinished(context: Context, localId: String, sendSeq: Int, outcome: SimOutcome, nowMs: Long) {
        val key = keyOf(localId, sendSeq)
        val current = load(context)
        val flight = current.inFlight
        if (flight != null && flight.key == key) {
            save(context, SimRotationPolicy.finished(current, flight.sim, nowMs))
            recordHealth(flight.sim, outcome)
            return
        }
        // Already counted as a timeout: a late success still proves the SIM works.
        val lateSim = timedOut[key] ?: return
        if (outcome == SimOutcome.SUCCESS) recordHealth(lateSim, outcome)
    }

    /** A send that failed before it got a send sequence (e.g. the SIM vanished). */
    @Synchronized
    fun onFailedBeforeStart(context: Context, sim: Int, outcome: SimOutcome, nowMs: Long) {
        val current = load(context)
        save(context, SimRotationPolicy.finished(current.copy(lastSim = sim), sim, nowMs))
        recordHealth(sim, outcome)
    }

    /** Health of every SIM the phone currently has, for the dashboard. */
    @Synchronized
    fun statuses(context: Context): List<SimStatus> =
        activeSims(context).map { SimStatus(it, health.isPaused(it), health.failureStreak(it)) }

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
        activeSims(context).filterNot { health.isPaused(it) }

    /** Active SIMs in slot order; the default-SIM stand-in when Android lists none. */
    private fun activeSims(context: Context): List<Int> {
        val listed = if (TextBeeUtils.isPermissionGranted(context, Manifest.permission.READ_PHONE_STATE)) {
            try {
                (TextBeeUtils.getAvailableSimSlots(context) ?: emptyList())
                    .filter { it.subscriptionId >= 0 }
                    .sortedWith(
                        compareBy<android.telephony.SubscriptionInfo> {
                            if (it.simSlotIndex >= 0) it.simSlotIndex else Int.MAX_VALUE
                        }.thenBy { it.subscriptionId }
                    )
                    .map { it.subscriptionId }
                    .distinct()
            } catch (e: Exception) {
                Log.e(TAG, "Unable to read active SIMs: ${e.message}", e)
                emptyList()
            }
        } else {
            emptyList()
        }
        return listed.ifEmpty { listOf(SimRotationPolicy.DEFAULT_SIM) }
    }

    private fun recordHealth(sim: Int, outcome: SimOutcome) {
        if (health.record(sim, outcome)) {
            Log.w(TAG, "SIM $sim paused after ${SimRotationPolicy.FAILURE_LIMIT} failed SMS in a row; it returns when the app restarts")
        }
    }

    private fun rememberTimedOut(flight: SimInFlight) {
        timedOut[flight.key] = flight.sim
        while (timedOut.size > MAX_TIMED_OUT_KEYS) {
            timedOut.remove(timedOut.keys.first())
        }
    }

    private fun keyOf(localId: String, sendSeq: Int) = "$localId#$sendSeq"

    private fun load(context: Context): SimRotationState {
        state?.let { return it }
        val lastSim = SharedPreferenceHelper.getSharedPreferenceInt(context, PREF_LAST_SIM, NO_SIM)
            .takeIf { it != NO_SIM }
        val lastAny = SharedPreferenceHelper.getSharedPreferenceString(context, PREF_LAST_CONFIRM_ANY_MS, null)
            ?.toLongOrNull()
        val bySim = SharedPreferenceHelper.getSharedPreferenceString(context, PREF_LAST_CONFIRM_BY_SIM, null)
            .orEmpty()
            .split(',')
            .mapNotNull { pair ->
                val parts = pair.split(':')
                val sim = parts.getOrNull(0)?.toIntOrNull()
                val at = parts.getOrNull(1)?.toLongOrNull()
                if (sim != null && at != null) sim to at else null
            }
            .toMap()
        val inFlight = SharedPreferenceHelper.getSharedPreferenceString(context, PREF_IN_FLIGHT, null)
            ?.let { raw ->
                // key|sim|submittedAt — the key may itself contain anything but the last two fields.
                val atSep = raw.lastIndexOf('|')
                val simSep = raw.lastIndexOf('|', atSep - 1)
                if (simSep <= 0) return@let null
                val sim = raw.substring(simSep + 1, atSep).toIntOrNull()
                val at = raw.substring(atSep + 1).toLongOrNull()
                if (sim == null || at == null) null else SimInFlight(raw.substring(0, simSep), sim, at)
            }
        return SimRotationState(lastSim, lastAny, bySim, inFlight).also { state = it }
    }

    private fun save(context: Context, next: SimRotationState) {
        state = next
        if (next.lastSim != null) {
            SharedPreferenceHelper.setSharedPreferenceInt(context, PREF_LAST_SIM, next.lastSim)
        } else {
            SharedPreferenceHelper.clearSharedPreference(context, PREF_LAST_SIM)
        }
        if (next.lastConfirmAnyMs != null) {
            SharedPreferenceHelper.setSharedPreferenceString(
                context, PREF_LAST_CONFIRM_ANY_MS, next.lastConfirmAnyMs.toString()
            )
        } else {
            SharedPreferenceHelper.clearSharedPreference(context, PREF_LAST_CONFIRM_ANY_MS)
        }
        SharedPreferenceHelper.setSharedPreferenceString(
            context, PREF_LAST_CONFIRM_BY_SIM,
            next.lastConfirmBySim.entries.joinToString(",") { "${it.key}:${it.value}" }
        )
        val flight = next.inFlight
        if (flight != null) {
            SharedPreferenceHelper.setSharedPreferenceString(
                context, PREF_IN_FLIGHT, "${flight.key}|${flight.sim}|${flight.submittedAtMs}"
            )
        } else {
            SharedPreferenceHelper.clearSharedPreference(context, PREF_IN_FLIGHT)
        }
    }
}
