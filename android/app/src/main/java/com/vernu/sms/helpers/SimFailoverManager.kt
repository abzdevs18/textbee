package com.vernu.sms.helpers

import android.Manifest
import android.content.Context
import android.telephony.SubscriptionInfo
import android.util.Log
import com.vernu.sms.TextBeeUtils

object SimFailoverManager {
    private const val TAG = "SimFailoverManager"
    private const val FAILURE_THRESHOLD = 2
    private const val NO_SIM = -1
    private const val NO_BATCH = "__no_sms_batch__"

    private const val KEY_ACTIVE_BATCH_ID = "SIM_FAILOVER_ACTIVE_BATCH_ID"
    private const val KEY_SOURCE_SIM_ID = "SIM_FAILOVER_SOURCE_SIM_ID"
    private const val KEY_TARGET_SIM_ID = "SIM_FAILOVER_TARGET_SIM_ID"
    private const val KEY_FAILURE_BATCH_ID = "SIM_FAILOVER_FAILURE_BATCH_ID"
    private const val KEY_FAILURE_SIM_ID = "SIM_FAILOVER_FAILURE_SIM_ID"
    private const val KEY_FAILURE_COUNT = "SIM_FAILOVER_FAILURE_COUNT"
    private const val KEY_LAST_FAILED_SMS_ID = "SIM_FAILOVER_LAST_FAILED_SMS_ID"

    fun resolveSendSim(context: Context, requestedSimSubscriptionId: Int?, smsBatchId: String?): Int? {
        if (requestedSimSubscriptionId == null) return null

        clearStateForNewBatch(context, smsBatchId)

        val sourceSim = SharedPreferenceHelper.getSharedPreferenceInt(
            context, KEY_SOURCE_SIM_ID, NO_SIM
        )
        val targetSim = SharedPreferenceHelper.getSharedPreferenceInt(
            context, KEY_TARGET_SIM_ID, NO_SIM
        )

        if (sourceSim != requestedSimSubscriptionId || targetSim == NO_SIM) {
            return requestedSimSubscriptionId
        }

        if (!TextBeeUtils.isValidSubscriptionId(context, targetSim)) {
            Log.w(TAG, "SIM failover target $targetSim is no longer active; using requested SIM $requestedSimSubscriptionId")
            clearActiveFailover(context)
            return requestedSimSubscriptionId
        }

        Log.w(TAG, "Using failover SIM $targetSim instead of requested SIM $requestedSimSubscriptionId")
        return targetSim
    }

    fun recordSendSuccess(context: Context, sendSimSubscriptionId: Int?, smsBatchId: String?) {
        if (sendSimSubscriptionId == null) return

        clearStateForNewBatch(context, smsBatchId)
        clearFailureCounter(context)
        Log.d(TAG, "SMS sent successfully on SIM $sendSimSubscriptionId; failure counter reset")
    }

    fun recordSendFailure(
        context: Context,
        requestedSimSubscriptionId: Int?,
        sendSimSubscriptionId: Int?,
        smsBatchId: String?,
        smsId: String?
    ) {
        val failedSim = sendSimSubscriptionId ?: requestedSimSubscriptionId ?: return

        clearStateForNewBatch(context, smsBatchId)

        val batchKey = normalizeBatchId(smsBatchId)
        val lastFailureSim = SharedPreferenceHelper.getSharedPreferenceInt(
            context, KEY_FAILURE_SIM_ID, NO_SIM
        )
        val lastFailedSmsId = SharedPreferenceHelper.getSharedPreferenceString(
            context, KEY_LAST_FAILED_SMS_ID, ""
        ) ?: ""
        val smsKey = smsId.orEmpty()

        if (lastFailureSim == failedSim && smsKey.isNotBlank() && smsKey == lastFailedSmsId) {
            Log.d(TAG, "Ignoring duplicate failure callback for SMS $smsKey on SIM $failedSim")
            return
        }

        val currentCount = SharedPreferenceHelper.getSharedPreferenceInt(
            context, KEY_FAILURE_COUNT, 0
        )
        val nextCount = if (lastFailureSim == failedSim) currentCount + 1 else 1

        SharedPreferenceHelper.setSharedPreferenceString(context, KEY_FAILURE_BATCH_ID, batchKey)
        SharedPreferenceHelper.setSharedPreferenceInt(context, KEY_FAILURE_SIM_ID, failedSim)
        SharedPreferenceHelper.setSharedPreferenceInt(context, KEY_FAILURE_COUNT, nextCount)
        SharedPreferenceHelper.setSharedPreferenceString(context, KEY_LAST_FAILED_SMS_ID, smsKey)

        Log.w(TAG, "SMS send failed on SIM $failedSim ($nextCount/$FAILURE_THRESHOLD consecutive failure(s))")

        if (nextCount < FAILURE_THRESHOLD) return

        val nextSim = findNextSim(context, failedSim)
        if (nextSim == null || nextSim == failedSim) {
            Log.w(TAG, "No alternate active SIM found after $FAILURE_THRESHOLD failures on SIM $failedSim")
            return
        }

        val sourceSim = requestedSimSubscriptionId ?: failedSim
        SharedPreferenceHelper.setSharedPreferenceString(context, KEY_ACTIVE_BATCH_ID, batchKey)

        if (nextSim == sourceSim) {
            clearActiveFailover(context)
            Log.w(TAG, "SIM $failedSim failed twice; next SIM wraps back to requested SIM $sourceSim")
        } else {
            SharedPreferenceHelper.setSharedPreferenceInt(context, KEY_SOURCE_SIM_ID, sourceSim)
            SharedPreferenceHelper.setSharedPreferenceInt(context, KEY_TARGET_SIM_ID, nextSim)
            Log.w(TAG, "Failing over batch $batchKey from requested SIM $sourceSim to SIM $nextSim")
        }

        clearFailureCounter(context)
    }

    private fun findNextSim(context: Context, currentSimSubscriptionId: Int): Int? {
        val activeSubscriptions = getActiveSubscriptions(context)
        if (activeSubscriptions.size < 2) return null

        val currentIndex = activeSubscriptions.indexOfFirst {
            it.subscriptionId == currentSimSubscriptionId
        }
        val startIndex = if (currentIndex >= 0) currentIndex + 1 else 0

        repeat(activeSubscriptions.size) { offset ->
            val candidate = activeSubscriptions[(startIndex + offset) % activeSubscriptions.size]
            if (candidate.subscriptionId != currentSimSubscriptionId) {
                return candidate.subscriptionId
            }
        }

        return null
    }

    private fun getActiveSubscriptions(context: Context): List<SubscriptionInfo> {
        if (!TextBeeUtils.isPermissionGranted(context, Manifest.permission.READ_PHONE_STATE)) {
            return emptyList()
        }

        return try {
            (TextBeeUtils.getAvailableSimSlots(context) ?: emptyList())
                .filter { it.subscriptionId != NO_SIM }
                .sortedWith(
                    compareBy<SubscriptionInfo> {
                        if (it.simSlotIndex >= 0) it.simSlotIndex else Int.MAX_VALUE
                    }.thenBy { it.subscriptionId }
                )
        } catch (e: Exception) {
            Log.e(TAG, "Unable to read active SIM subscriptions: ${e.message}", e)
            emptyList()
        }
    }

    private fun clearStateForNewBatch(context: Context, smsBatchId: String?) {
        val batchKey = normalizeBatchId(smsBatchId)
        val activeBatchId = SharedPreferenceHelper.getSharedPreferenceString(
            context, KEY_ACTIVE_BATCH_ID, null
        )
        if (activeBatchId != null && activeBatchId != batchKey) {
            clearActiveFailover(context)
        }

        val failureBatchId = SharedPreferenceHelper.getSharedPreferenceString(
            context, KEY_FAILURE_BATCH_ID, null
        )
        if (failureBatchId != null && failureBatchId != batchKey) {
            clearFailureCounter(context)
        }
    }

    private fun clearActiveFailover(context: Context) {
        SharedPreferenceHelper.clearSharedPreference(context, KEY_ACTIVE_BATCH_ID)
        SharedPreferenceHelper.clearSharedPreference(context, KEY_SOURCE_SIM_ID)
        SharedPreferenceHelper.clearSharedPreference(context, KEY_TARGET_SIM_ID)
    }

    private fun clearFailureCounter(context: Context) {
        SharedPreferenceHelper.clearSharedPreference(context, KEY_FAILURE_BATCH_ID)
        SharedPreferenceHelper.clearSharedPreference(context, KEY_FAILURE_SIM_ID)
        SharedPreferenceHelper.clearSharedPreference(context, KEY_FAILURE_COUNT)
        SharedPreferenceHelper.clearSharedPreference(context, KEY_LAST_FAILED_SMS_ID)
    }

    private fun normalizeBatchId(smsBatchId: String?): String {
        return smsBatchId?.takeIf { it.isNotBlank() } ?: NO_BATCH
    }
}
