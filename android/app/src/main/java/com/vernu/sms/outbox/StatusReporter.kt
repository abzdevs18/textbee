package com.vernu.sms.outbox

import android.content.Context
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.dtos.SMSDTO
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.workers.SMSStatusUpdateWorker

/** Turns local outbox outcomes into durable status reports for the API. */
object StatusReporter {
    private const val TAG = "StatusReporter"

    const val ERROR_EXPIRED = "EXPIRED_MAX_AGE"
    const val ERROR_GATEWAY_DISABLED = "GATEWAY_DISABLED"
    const val ERROR_PERMISSION_DENIED = "PERMISSION_DENIED"
    const val ERROR_INVALID_RECIPIENT = "INVALID_RECIPIENT"
    const val ERROR_SENDING_EXCEPTION = "SENDING_EXCEPTION"

    /** Reports the final state of an entry (SENT, DELIVERED, FAILED or EXPIRED). */
    @JvmStatic
    fun reportFinal(context: Context, entry: OutboxEntry) {
        val now = System.currentTimeMillis()
        val at = entry.completedAtMs ?: now
        val dto = SMSDTO().apply {
            smsId = entry.smsId
            smsBatchId = entry.batchId
            attempt = entry.attempt
        }
        when (entry.state) {
            LocalState.SENT -> {
                dto.status = "SENT"
                dto.sentAtInMillis = at
            }
            LocalState.DELIVERED -> {
                dto.status = "DELIVERED"
                dto.deliveredAtInMillis = at
            }
            LocalState.FAILED -> {
                dto.status = "FAILED"
                dto.failedAtInMillis = at
                dto.errorCode = entry.errorCode ?: ERROR_SENDING_EXCEPTION
                dto.errorMessage = entry.errorMessage ?: "SMS could not be sent from this phone"
            }
            LocalState.EXPIRED -> {
                dto.status = "FAILED"
                dto.failedAtInMillis = at
                dto.errorCode = ERROR_EXPIRED
                dto.errorMessage = entry.errorMessage
                    ?: "SMS exceeded max pending age (2 hours); device refused send"
            }
            else -> return
        }
        enqueue(context, dto)
    }

    /** Delivery receipt problems are informational; the API maps them onto sent/delivered. */
    @JvmStatic
    fun reportDeliveryFailed(context: Context, entry: OutboxEntry, errorCode: String?, errorMessage: String?) {
        enqueue(context, SMSDTO().apply {
            smsId = entry.smsId
            smsBatchId = entry.batchId
            attempt = entry.attempt
            status = "DELIVERY_FAILED"
            this.errorCode = errorCode
            this.errorMessage = errorMessage
        })
    }

    /** Reports a refusal for a command that never entered the outbox. */
    @JvmStatic
    fun reportRefusal(
        context: Context,
        smsId: String,
        smsBatchId: String?,
        attempt: Int?,
        errorCode: String,
        errorMessage: String
    ) {
        enqueue(context, SMSDTO().apply {
            this.smsId = smsId
            this.smsBatchId = smsBatchId
            this.attempt = attempt
            status = "FAILED"
            failedAtInMillis = System.currentTimeMillis()
            this.errorCode = errorCode
            this.errorMessage = errorMessage
        })
    }

    @JvmStatic
    fun enqueue(context: Context, dto: SMSDTO) {
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""
        if (deviceId.isEmpty() || apiKey.isEmpty() || dto.smsId.isNullOrBlank()) {
            Log.e(TAG, "Cannot report SMS status: device not registered or SMS id missing")
            return
        }
        SMSStatusUpdateWorker.enqueueWork(context, deviceId, apiKey, dto)
    }
}
