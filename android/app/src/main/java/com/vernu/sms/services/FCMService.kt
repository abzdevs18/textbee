package com.vernu.sms.services

import android.util.Log
import androidx.core.os.UserManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.google.gson.Gson
import com.vernu.sms.ApiManager
import com.vernu.sms.AppConstants
import com.vernu.sms.dtos.RegisterDeviceInputDTO
import com.vernu.sms.dtos.RegisterDeviceResponseDTO
import com.vernu.sms.helpers.GatewayConfigSync
import com.vernu.sms.helpers.HeartbeatHelper
import com.vernu.sms.helpers.HeartbeatManager
import com.vernu.sms.helpers.SMSHelper
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.models.SMSPayload
import com.vernu.sms.outbox.OutboxSync
import com.vernu.sms.outbox.SmsDispatcher
import com.vernu.sms.workers.OutboxClaimWorker
import retrofit2.Call
import retrofit2.Callback
import retrofit2.Response

class FCMService : FirebaseMessagingService() {
    companion object {
        private const val TAG = "FCMService"
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.d(
            TAG,
            "FCM data message received: id=${remoteMessage.messageId}, priority=${remoteMessage.priority}/${remoteMessage.originalPriority}, keys=${remoteMessage.data.keys}"
        )

        // Direct-boot delivery before the first unlock: prefs and the outbox
        // are not readable yet. The server lease and the pull loop recover it.
        if (!UserManagerCompat.isUserUnlocked(this)) {
            Log.w(TAG, "Device locked since boot; deferring FCM command to the outbox pull")
            return
        }

        try {
            when (remoteMessage.data["type"]) {
                "heartbeat_check" -> {
                    handleHeartbeatCheck()
                    return
                }
                // Web/API toggled gateway on/off — update local switch immediately
                "device_config" -> {
                    val enabledRaw = remoteMessage.data["enabled"]
                    val enabled = enabledRaw.equals("true", ignoreCase = true) || enabledRaw == "1"
                    Log.d(TAG, "Received device_config enabled=$enabled")
                    GatewayConfigSync.applyServerEnabled(this, enabled)
                    return
                }
                // Central outbox: pull work now, inside this wake-up window
                "work_available" -> {
                    if (!GatewayConfigSync.isGatewayEnabled(this)) {
                        Log.d(TAG, "Ignoring work_available — gateway disabled")
                        return
                    }
                    // Falls back to OutboxClaimWorker by itself if the pull fails.
                    OutboxSync.claimAndDispatch(this, "push")
                    return
                }
            }

            val smsDataJson = remoteMessage.data["smsData"]
            if (smsDataJson == null) {
                Log.e(TAG, "FCM data message is missing smsData")
                return
            }

            val smsPayload = Gson().fromJson(smsDataJson, SMSPayload::class.java) ?: return
            val targetDeviceId = remoteMessage.data["targetDeviceId"]
                ?: remoteMessage.data["deviceId"]
                ?: smsPayload.targetDeviceId
                ?: smsPayload.deviceId
            if (!isForThisDevice(targetDeviceId, smsPayload.smsId)) {
                return
            }

            if (!GatewayConfigSync.isGatewayEnabled(this)) {
                // Tell the server instead of dropping silently, otherwise the SMS
                // sits in `dispatched` until it expires.
                Log.w(TAG, "Refusing SMS command — gateway disabled on this device")
                val id = smsPayload.smsId
                if (!id.isNullOrBlank()) {
                    SMSHelper.reportGatewayDisabled(this, id, smsPayload.smsBatchId ?: "", smsPayload.attempt)
                }
                return
            }

            // Persist first, then hand due SMS to the radio right here: no
            // deferred job sits between the push and Android's SMS stack.
            SmsDispatcher.accept(this, smsPayload, "push")
            SmsDispatcher.pump(this)
        } catch (e: Exception) {
            Log.e(TAG, "Error processing FCM message: ${e.message}", e)
            // Whatever we could not process is still leased to us on the server.
            OutboxClaimWorker.enqueue(this)
        }
    }

    /** FCM dropped queued messages for this app (too many or expired): resync from the server. */
    override fun onDeletedMessages() {
        Log.w(TAG, "FCM deleted pending messages; resyncing outbox")
        if (UserManagerCompat.isUserUnlocked(this)) {
            OutboxSync.requestClaim(this, "fcm-deleted")
        }
    }

    private fun handleHeartbeatCheck() {
        Log.d(TAG, "Received heartbeat check request from backend")

        if (!HeartbeatHelper.isDeviceEligibleForHeartbeat(this)) {
            Log.d(TAG, "Device not eligible for heartbeat, skipping heartbeat check")
            return
        }

        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            this, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            this, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""

        val success = HeartbeatHelper.sendHeartbeat(this, deviceId, apiKey)
        if (success) {
            Log.d(TAG, "Heartbeat sent successfully in response to backend check")
        } else {
            Log.e(TAG, "Failed to send heartbeat in response to backend check")
        }
        HeartbeatManager.scheduleHeartbeat(this)
    }

    private fun isForThisDevice(targetDeviceId: String?, smsId: String?): Boolean {
        if (targetDeviceId.isNullOrBlank()) {
            Log.w(TAG, "SMS command ${smsId ?: "(unknown)"} has no target device id; accepting legacy payload")
            return true
        }

        val localDeviceId = SharedPreferenceHelper.getSharedPreferenceString(
            this, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        if (localDeviceId.isBlank()) {
            Log.e(TAG, "Ignoring SMS command ${smsId ?: "(unknown)"} because local device id is not configured")
            return false
        }

        if (targetDeviceId != localDeviceId) {
            Log.w(
                TAG,
                "Ignoring SMS command ${smsId ?: "(unknown)"} for device $targetDeviceId on local device $localDeviceId"
            )
            return false
        }

        return true
    }

    override fun onNewToken(token: String) {
        sendRegistrationToServer(token)
    }

    private fun sendRegistrationToServer(token: String) {
        if (!UserManagerCompat.isUserUnlocked(this)) return
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            this, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            this, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""

        if (deviceId.isEmpty() || apiKey.isEmpty()) {
            Log.d(TAG, "Device ID or API key not available, skipping FCM token update")
            return
        }

        val updateInput = RegisterDeviceInputDTO().apply { fcmToken = token }
        Log.d(TAG, "Updating FCM token for device: $deviceId")

        ApiManager.getApiService()
            .updateDevice(deviceId, apiKey, updateInput)
            .enqueue(object : Callback<RegisterDeviceResponseDTO> {
                override fun onResponse(
                    call: Call<RegisterDeviceResponseDTO>,
                    response: Response<RegisterDeviceResponseDTO>
                ) {
                    if (response.isSuccessful) {
                        Log.d(TAG, "FCM token updated successfully")
                    } else {
                        Log.e(TAG, "Failed to update FCM token. Response code: ${response.code()}")
                    }
                }

                override fun onFailure(call: Call<RegisterDeviceResponseDTO>, t: Throwable) {
                    Log.e(TAG, "Error updating FCM token: ${t.message}")
                }
            })
    }
}
