package com.vernu.sms.helpers

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import com.vernu.sms.outbox.OutboxEntry
import com.vernu.sms.outbox.StatusReporter
import com.vernu.sms.receivers.SMSStatusReceiver

/** Thin wrapper around Android's SmsManager used by the outbox dispatcher. */
object SMSHelper {

    /** SmsManager for the requested SIM, or the phone's default SMS SIM. */
    @JvmStatic
    @Suppress("DEPRECATION")
    fun smsManagerFor(context: Context, subscriptionId: Int?): SmsManager {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val system = context.getSystemService(SmsManager::class.java)
            if (system != null) {
                return if (subscriptionId != null) {
                    system.createForSubscriptionId(subscriptionId)
                } else {
                    system
                }
            }
        }
        return if (subscriptionId != null) {
            SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
        } else {
            SmsManager.getDefault()
        }
    }

    @JvmStatic
    fun divide(manager: SmsManager, message: String): ArrayList<String> {
        val parts = manager.divideMessage(message)
        return if (parts.isNullOrEmpty()) arrayListOf(message) else parts
    }

    /**
     * Hands one SMS to the radio. Every part gets its own PendingIntent (unique
     * data URI) so the receiver can tell parts — and send attempts — apart.
     * Throws whatever SmsManager throws; the caller records the failure.
     */
    @JvmStatic
    fun submit(
        context: Context,
        manager: SmsManager,
        entry: OutboxEntry,
        parts: ArrayList<String>,
        sendSeq: Int,
        requestedSimId: Int?,
        resolvedSimId: Int?
    ) {
        val partCount = parts.size
        val sentIntents = ArrayList<PendingIntent>(partCount)
        val deliveredIntents = ArrayList<PendingIntent>(partCount)
        for (index in 0 until partCount) {
            sentIntents.add(
                statusIntent(
                    context, SMSStatusReceiver.SMS_SENT, entry, sendSeq, index, partCount,
                    requestedSimId, resolvedSimId
                )
            )
            deliveredIntents.add(
                statusIntent(
                    context, SMSStatusReceiver.SMS_DELIVERED, entry, sendSeq, index, partCount,
                    requestedSimId, resolvedSimId
                )
            )
        }

        if (partCount > 1) {
            manager.sendMultipartTextMessage(
                entry.recipient, null, parts, sentIntents, deliveredIntents
            )
        } else {
            manager.sendTextMessage(
                entry.recipient, null, parts[0], sentIntents[0], deliveredIntents[0]
            )
        }
    }

    /** Maps an SmsManager exception to an error code the API understands. */
    @JvmStatic
    fun classifySendException(error: Throwable): Pair<String, String> {
        val detail = error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
        return when {
            error is SecurityException ->
                StatusReporter.ERROR_PERMISSION_DENIED to "SMS permission not granted: $detail"
            error is IllegalArgumentException && detail.contains("destination", ignoreCase = true) ->
                StatusReporter.ERROR_INVALID_RECIPIENT to "Invalid recipient number: $detail"
            else ->
                StatusReporter.ERROR_SENDING_EXCEPTION to detail
        }
    }

    /**
     * Report that this device will not send because its gateway is switched off,
     * so the server can fail over to another device instead of waiting.
     */
    @JvmStatic
    fun reportGatewayDisabled(context: Context, smsId: String, smsBatchId: String, attempt: Int? = null) {
        StatusReporter.reportRefusal(
            context, smsId, smsBatchId, attempt,
            StatusReporter.ERROR_GATEWAY_DISABLED,
            "Gateway is disabled on this device; command refused"
        )
    }

    private fun statusIntent(
        context: Context,
        action: String,
        entry: OutboxEntry,
        sendSeq: Int,
        partIndex: Int,
        partCount: Int,
        requestedSimId: Int?,
        resolvedSimId: Int?
    ): PendingIntent {
        val intent = Intent(context, SMSStatusReceiver::class.java).apply {
            this.action = action
            // Unique per SMS, send attempt and part; extras alone do not make
            // PendingIntents distinct, and hash-colliding request codes used to
            // let one SMS overwrite another's callback.
            data = Uri.Builder()
                .scheme("gabay-sms")
                .authority("status")
                .appendPath(action)
                .appendPath(entry.localId)
                .appendPath(sendSeq.toString())
                .appendPath(partIndex.toString())
                .build()
            putExtra(SMSStatusReceiver.EXTRA_SMS_ID, entry.smsId)
            putExtra(SMSStatusReceiver.EXTRA_SMS_BATCH_ID, entry.batchId)
            putExtra(SMSStatusReceiver.EXTRA_LOCAL_ID, entry.localId)
            putExtra(SMSStatusReceiver.EXTRA_SEND_SEQ, sendSeq)
            putExtra(SMSStatusReceiver.EXTRA_PART_INDEX, partIndex)
            putExtra(SMSStatusReceiver.EXTRA_PART_COUNT, partCount)
            requestedSimId?.let {
                putExtra(SMSStatusReceiver.EXTRA_REQUESTED_SIM_SUBSCRIPTION_ID, it)
            }
            resolvedSimId?.let {
                putExtra(SMSStatusReceiver.EXTRA_RESOLVED_SIM_SUBSCRIPTION_ID, it)
            }
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        // The radio fills in result extras, so the intent must stay mutable.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
        val requestCode = "${entry.localId}|$sendSeq|$partIndex|$action".hashCode()
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }
}
