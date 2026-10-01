package com.vernu.sms.receivers

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.util.Log
import com.vernu.sms.dtos.SMSDTO
import com.vernu.sms.helpers.MessageSyncNotifier
import com.vernu.sms.helpers.SimFailoverManager
import com.vernu.sms.outbox.LocalState
import com.vernu.sms.outbox.OutboxEntry
import com.vernu.sms.outbox.OutboxStore
import com.vernu.sms.outbox.PartOutcome
import com.vernu.sms.outbox.SmsDispatcher
import com.vernu.sms.outbox.StatusReporter
import java.lang.reflect.Modifier

/**
 * Radio callbacks for sent/delivered SMS. Multipart messages report once per
 * part; the outbox aggregates them so the API receives a single outcome.
 */
class SMSStatusReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "SMSStatusReceiver"
        const val SMS_SENT = "SMS_SENT"
        const val SMS_DELIVERED = "SMS_DELIVERED"

        // Legacy keys (≤ 2.8.19 PendingIntents) — kept for callbacks in flight across an upgrade.
        const val EXTRA_SMS_ID = "sms_id"
        const val EXTRA_SMS_BATCH_ID = "sms_batch_id"
        const val EXTRA_REQUESTED_SIM_SUBSCRIPTION_ID = "requested_sim_subscription_id"
        const val EXTRA_RESOLVED_SIM_SUBSCRIPTION_ID = "resolved_sim_subscription_id"

        const val EXTRA_LOCAL_ID = "outbox_local_id"
        const val EXTRA_SEND_SEQ = "outbox_send_seq"
        const val EXTRA_PART_INDEX = "outbox_part_index"
        const val EXTRA_PART_COUNT = "outbox_part_count"

        private fun getResultCodeName(resultCode: Int): String? {
            for (clazz in arrayOf<Class<*>>(SmsManager::class.java, Activity::class.java)) {
                try {
                    for (field in clazz.declaredFields) {
                        if (field.type != Int::class.javaPrimitiveType) continue
                        if (!Modifier.isStatic(field.modifiers) || !Modifier.isFinal(field.modifiers)) continue
                        if (!field.name.startsWith("RESULT_")) continue
                        field.isAccessible = true
                        if (field.getInt(null) == resultCode) return "${clazz.simpleName}.${field.name}"
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Reflection failed for ${clazz.simpleName}: ${e.message}")
                }
            }
            return null
        }

        /** Human-readable reason for a failed SENT callback. */
        @JvmStatic
        fun describeSendFailure(intent: Intent, resultCode: Int): String = when (resultCode) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> {
                val radioCode = intent.getIntExtra("errorCode", -1)
                var msg = "SMS failed on device. Common causes: no SMS credit on SIM, weak signal, or carrier blocked. Check SIM balance and signal, then try again."
                if (radioCode != -1) msg += " (code $radioCode)"
                msg
            }
            SmsManager.RESULT_ERROR_RADIO_OFF ->
                "Mobile radio is off (e.g. airplane mode). Turn off airplane mode and ensure cellular is on."
            SmsManager.RESULT_ERROR_NULL_PDU ->
                "Message could not be sent; invalid format or carrier issue. Try a shorter message or different recipient."
            SmsManager.RESULT_ERROR_NO_SERVICE ->
                "No cellular service. Check signal and try again when you have coverage."
            SmsManager.RESULT_ERROR_LIMIT_EXCEEDED ->
                "Device/carrier send limit reached (too many SMS in a short time). Wait a few minutes or lower the send rate."
            SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED ->
                "Short code not allowed on this carrier. Use a full phone number."
            SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED ->
                "Short codes are not supported on this carrier. Use a full phone number."
            SmsManager.RESULT_NETWORK_ERROR ->
                "Network error while sending. Check signal and try again."
            else -> getResultCodeName(resultCode) ?: "Unknown error (code $resultCode)"
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val code = resultCode
        val app = context.applicationContext
        val pending = goAsync()
        SmsDispatcher.runInBackground {
            try {
                handle(app, intent, code)
            } finally {
                pending.finish()
            }
        }
    }

    private fun handle(context: Context, intent: Intent, resultCode: Int) {
        val localId = intent.getStringExtra(EXTRA_LOCAL_ID)
        val sendSeq = intent.getIntExtra(EXTRA_SEND_SEQ, -1)
        if (localId.isNullOrBlank() || sendSeq < 0) {
            handleLegacy(context, intent, resultCode)
            return
        }
        val partIndex = intent.getIntExtra(EXTRA_PART_INDEX, 0)
        val partCount = intent.getIntExtra(EXTRA_PART_COUNT, 1)
        val store = OutboxStore.get(context)
        val now = System.currentTimeMillis()

        when (intent.action) {
            SMS_SENT -> {
                val ok = resultCode == Activity.RESULT_OK
                val outcome = store.recordSentPart(
                    localId, sendSeq, partIndex, partCount, ok,
                    if (ok) null else resultCode.toString(),
                    if (ok) null else describeSendFailure(intent, resultCode),
                    now
                )
                if (!ok) Log.e(TAG, "SMS $localId part ${partIndex + 1}/$partCount failed (code $resultCode)")
                if (outcome is PartOutcome.Completed) complete(context, outcome.entry)
            }
            SMS_DELIVERED -> {
                if (resultCode == Activity.RESULT_OK) {
                    val outcome = store.recordDeliveredPart(localId, sendSeq, partIndex, partCount, now)
                    if (outcome is PartOutcome.Completed) complete(context, outcome.entry)
                } else {
                    val entry = store.get(localId)
                    if (entry != null && entry.sendSeq == sendSeq) {
                        val message = if (resultCode == Activity.RESULT_CANCELED) {
                            "Delivery report was canceled (e.g. carrier does not support delivery receipts). Message may still have been delivered."
                        } else {
                            getResultCodeName(resultCode) ?: "Unknown delivery error (code $resultCode)"
                        }
                        StatusReporter.reportDeliveryFailed(context, entry, resultCode.toString(), message)
                    }
                }
            }
        }
    }

    private fun complete(context: Context, entry: OutboxEntry) {
        when (entry.state) {
            LocalState.SENT, LocalState.DELIVERED -> {
                Log.d(TAG, "SMS ${entry.localId} ${entry.state.name.lowercase()}")
                if (entry.state == LocalState.SENT) {
                    SimFailoverManager.recordSendSuccess(
                        context, entry.resolvedSimId ?: entry.requestedSimId, entry.batchId
                    )
                }
            }
            LocalState.FAILED -> SimFailoverManager.recordSendFailure(
                context, entry.requestedSimId, entry.resolvedSimId, entry.batchId, entry.smsId
            )
            else -> Unit
        }
        StatusReporter.reportFinal(context, entry)
        MessageSyncNotifier.notifyChanged(context)
    }

    /** Callbacks for PendingIntents created by app versions before the outbox. */
    private fun handleLegacy(context: Context, intent: Intent, resultCode: Int) {
        val smsId = intent.getStringExtra(EXTRA_SMS_ID) ?: return
        val dto = SMSDTO().apply {
            this.smsId = smsId
            smsBatchId = intent.getStringExtra(EXTRA_SMS_BATCH_ID)
        }
        val now = System.currentTimeMillis()
        when (intent.action) {
            SMS_SENT -> if (resultCode == Activity.RESULT_OK) {
                dto.status = "SENT"
                dto.sentAtInMillis = now
            } else {
                dto.status = "FAILED"
                dto.failedAtInMillis = now
                dto.errorCode = resultCode.toString()
                dto.errorMessage = describeSendFailure(intent, resultCode)
            }
            SMS_DELIVERED -> if (resultCode == Activity.RESULT_OK) {
                dto.status = "DELIVERED"
                dto.deliveredAtInMillis = now
            } else {
                dto.status = "DELIVERY_FAILED"
                dto.errorCode = resultCode.toString()
                dto.errorMessage = getResultCodeName(resultCode)
                    ?: "Unknown delivery error (code $resultCode)"
            }
            else -> return
        }
        StatusReporter.enqueue(context, dto)
    }
}
