package com.vernu.sms.helpers

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsManager
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.dtos.SMSDTO
import com.vernu.sms.receivers.SMSStatusReceiver
import com.vernu.sms.workers.SMSStatusUpdateWorker

object SMSHelper {
    private const val TAG = "SMSHelper"

    @JvmStatic
    fun sendSMS(
        phoneNo: String,
        message: String,
        smsId: String,
        smsBatchId: String,
        context: Context,
        requestedSimSubscriptionId: Int? = null,
        resolvedSimSubscriptionId: Int? = null
    ): Boolean {
        if (!TextBeeUtils.isPermissionGranted(context, Manifest.permission.SEND_SMS)) {
            Log.e(TAG, "SMS permission not granted. Unable to send SMS.")
            reportPermissionError(context, smsId, smsBatchId)
            return false
        }
        return try {
            val smsManager = SmsManager.getDefault()
            val sentIntent = createSentPendingIntent(
                context, smsId, smsBatchId, requestedSimSubscriptionId, resolvedSimSubscriptionId
            )
            val deliveredIntent = createDeliveredPendingIntent(
                context, smsId, smsBatchId, requestedSimSubscriptionId, resolvedSimSubscriptionId
            )
            val parts = smsManager.divideMessage(message)
            if (parts.size > 1) {
                val sentIntents = ArrayList<PendingIntent>(parts.size).also { list ->
                    repeat(parts.size) { list.add(sentIntent) }
                }
                val deliveredIntents = ArrayList<PendingIntent>(parts.size).also { list ->
                    repeat(parts.size) { list.add(deliveredIntent) }
                }
                smsManager.sendMultipartTextMessage(phoneNo, null, parts, sentIntents, deliveredIntents)
            } else {
                smsManager.sendTextMessage(phoneNo, null, message, sentIntent, deliveredIntent)
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Exception when sending SMS: ${e.message}")
            reportSendingError(
                context, smsId, smsBatchId, e.message, requestedSimSubscriptionId, resolvedSimSubscriptionId
            )
            false
        }
    }

    @JvmStatic
    fun sendSMSFromSpecificSim(
        phoneNo: String,
        message: String,
        simSubscriptionId: Int,
        smsId: String,
        smsBatchId: String,
        context: Context,
        requestedSimSubscriptionId: Int? = simSubscriptionId
    ): Boolean {
        if (!TextBeeUtils.isPermissionGranted(context, Manifest.permission.SEND_SMS) ||
            !TextBeeUtils.isPermissionGranted(context, Manifest.permission.READ_PHONE_STATE)
        ) {
            Log.e(TAG, "SMS or Phone State permission not granted. Unable to send SMS from specific SIM.")
            reportPermissionError(context, smsId, smsBatchId)
            return false
        }
        return try {
            @Suppress("DEPRECATION")
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                SmsManager.getSmsManagerForSubscriptionId(simSubscriptionId)
            } else {
                Log.w(TAG, "Using default SIM as specific SIM selection not supported on this Android version")
                SmsManager.getDefault()
            }
            val sentIntent = createSentPendingIntent(
                context, smsId, smsBatchId, requestedSimSubscriptionId, simSubscriptionId
            )
            val deliveredIntent = createDeliveredPendingIntent(
                context, smsId, smsBatchId, requestedSimSubscriptionId, simSubscriptionId
            )
            val parts = smsManager.divideMessage(message)
            if (parts.size > 1) {
                val sentIntents = ArrayList<PendingIntent>(parts.size).also { list ->
                    repeat(parts.size) { list.add(sentIntent) }
                }
                val deliveredIntents = ArrayList<PendingIntent>(parts.size).also { list ->
                    repeat(parts.size) { list.add(deliveredIntent) }
                }
                smsManager.sendMultipartTextMessage(phoneNo, null, parts, sentIntents, deliveredIntents)
            } else {
                smsManager.sendTextMessage(phoneNo, null, message, sentIntent, deliveredIntent)
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Exception when sending SMS from specific SIM: ${e.message}")
            reportSendingError(
                context, smsId, smsBatchId, e.message, requestedSimSubscriptionId, simSubscriptionId
            )
            false
        }
    }

    private fun reportPermissionError(context: Context, smsId: String, smsBatchId: String) {
        val smsDTO = SMSDTO().apply {
            this.smsId = smsId
            this.smsBatchId = smsBatchId
            status = "FAILED"
            failedAtInMillis = System.currentTimeMillis()
            errorCode = "PERMISSION_DENIED"
            errorMessage = "SMS permission not granted"
        }
        updateSMSStatus(context, smsDTO)
    }

    /**
     * Report that the device refused to send because the SMS exceeded max age (2h).
     * Server treats FAILED as failover/cancel path.
     */
    @JvmStatic
    fun reportExpired(context: Context, smsId: String, smsBatchId: String) {
        val smsDTO = SMSDTO().apply {
            this.smsId = smsId
            this.smsBatchId = smsBatchId
            status = "FAILED"
            failedAtInMillis = System.currentTimeMillis()
            errorCode = "EXPIRED_MAX_AGE"
            errorMessage = "SMS exceeded max pending age (2 hours); device refused send"
        }
        updateSMSStatus(context, smsDTO)
    }

    /**
     * Report that this device will not send because its gateway is switched off,
     * so the server can fail over to another device instead of waiting.
     */
    @JvmStatic
    fun reportGatewayDisabled(context: Context, smsId: String, smsBatchId: String) {
        val smsDTO = SMSDTO().apply {
            this.smsId = smsId
            this.smsBatchId = smsBatchId
            status = "FAILED"
            failedAtInMillis = System.currentTimeMillis()
            errorCode = "GATEWAY_DISABLED"
            errorMessage = "Gateway is disabled on this device; command refused"
        }
        updateSMSStatus(context, smsDTO)
    }

    private fun reportSendingError(
        context: Context,
        smsId: String,
        smsBatchId: String,
        error: String?,
        requestedSimSubscriptionId: Int?,
        resolvedSimSubscriptionId: Int?
    ) {
        val smsDTO = SMSDTO().apply {
            this.smsId = smsId
            this.smsBatchId = smsBatchId
            status = "FAILED"
            failedAtInMillis = System.currentTimeMillis()
            errorCode = "SENDING_EXCEPTION"
            errorMessage = error
        }
        SimFailoverManager.recordSendFailure(
            context, requestedSimSubscriptionId, resolvedSimSubscriptionId, smsBatchId, smsId
        )
        updateSMSStatus(context, smsDTO)
    }

    private fun updateSMSStatus(context: Context, smsDTO: SMSDTO) {
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""
        if (deviceId.isEmpty() || apiKey.isEmpty()) {
            Log.e(TAG, "Device ID or API key not found")
            return
        }
        SMSStatusUpdateWorker.enqueueWork(context, deviceId, apiKey, smsDTO)
    }

    private fun createSentPendingIntent(
        context: Context,
        smsId: String,
        smsBatchId: String,
        requestedSimSubscriptionId: Int?,
        resolvedSimSubscriptionId: Int?
    ): PendingIntent {
        val intent = Intent(context, SMSStatusReceiver::class.java).apply {
            action = SMSStatusReceiver.SMS_SENT
            putExtra("sms_id", smsId)
            putExtra("sms_batch_id", smsBatchId)
            requestedSimSubscriptionId?.let {
                putExtra(SMSStatusReceiver.EXTRA_REQUESTED_SIM_SUBSCRIPTION_ID, it)
            }
            resolvedSimSubscriptionId?.let {
                putExtra(SMSStatusReceiver.EXTRA_RESOLVED_SIM_SUBSCRIPTION_ID, it)
            }
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, (smsId + "_sent").hashCode(), intent, flags)
    }

    private fun createDeliveredPendingIntent(
        context: Context,
        smsId: String,
        smsBatchId: String,
        requestedSimSubscriptionId: Int?,
        resolvedSimSubscriptionId: Int?
    ): PendingIntent {
        val intent = Intent(context, SMSStatusReceiver::class.java).apply {
            action = SMSStatusReceiver.SMS_DELIVERED
            putExtra("sms_id", smsId)
            putExtra("sms_batch_id", smsBatchId)
            requestedSimSubscriptionId?.let {
                putExtra(SMSStatusReceiver.EXTRA_REQUESTED_SIM_SUBSCRIPTION_ID, it)
            }
            resolvedSimSubscriptionId?.let {
                putExtra(SMSStatusReceiver.EXTRA_RESOLVED_SIM_SUBSCRIPTION_ID, it)
            }
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, (smsId + "_delivered").hashCode(), intent, flags)
    }
}
