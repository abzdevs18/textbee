package com.vernu.sms.ui.onboarding

import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.messaging.FirebaseMessaging
import com.vernu.sms.ApiManagerKt
import com.vernu.sms.AppConstants
import com.vernu.sms.BuildConfig
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.dtos.RegisterDeviceInputDTO
import com.vernu.sms.dtos.SimInfoCollectionDTO
import com.vernu.sms.helpers.HeartbeatManager
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.helpers.serverErrorMessage
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

data class OnboardingState(
    val apiKey: String = "",
    val deviceId: String = "",
    val deviceName: String = "${Build.BRAND} ${Build.MODEL}",
    val isReturningUser: Boolean = false,
    val useExistingDeviceId: Boolean = false,
    val isQrScanned: Boolean = false,
    val qrScanFailed: Boolean = false,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val registeredDeviceId: String? = null,
    val registeredDeviceName: String? = null,
    val registrationWarning: String? = null
)

class OnboardingViewModel : ViewModel() {
    companion object {
        private const val TAG = "OnboardingViewModel"
        private const val FCM_TOKEN_TIMEOUT_MS = 8_000L
    }

    private val _state = MutableStateFlow(OnboardingState())
    val state: StateFlow<OnboardingState> = _state.asStateFlow()

    private val _registrationSuccess = Channel<Unit>(Channel.CONFLATED)
    val registrationSuccess = _registrationSuccess.receiveAsFlow()

    fun setApiKey(key: String) {
        _state.update { it.copy(apiKey = key.trim(), errorMessage = null, isQrScanned = false, qrScanFailed = false) }
    }

    fun onQrScanned(rawValue: String) {
        val apiKey = extractApiKey(rawValue)
        _state.update {
            it.copy(
                apiKey = apiKey,
                errorMessage = if (apiKey.isBlank()) "The QR code did not contain an API key. Try manual entry." else null,
                isQrScanned = apiKey.isNotBlank(),
                qrScanFailed = apiKey.isBlank()
            )
        }
    }

    fun onQrScanFailed() {
        _state.update {
            it.copy(
                errorMessage = "The camera could not read the QR code. I switched you to manual entry; paste the API key from the dashboard.",
                isQrScanned = false,
                qrScanFailed = true
            )
        }
    }

    fun setDeviceId(id: String) {
        _state.update { it.copy(deviceId = id.trim(), errorMessage = null) }
    }

    fun setDeviceName(name: String) {
        _state.update { it.copy(deviceName = name) }
    }

    fun setReturningUser(returning: Boolean) {
        _state.update { it.copy(isReturningUser = returning, useExistingDeviceId = returning) }
    }

    fun setUseExistingDeviceId(use: Boolean) {
        _state.update { it.copy(useExistingDeviceId = use, deviceId = if (!use) "" else it.deviceId) }
    }

    fun clearError() {
        _state.update { it.copy(errorMessage = null, qrScanFailed = false) }
    }

    fun registerOrUpdateDevice(context: Context) {
        val current = _state.value
        val apiKey = extractApiKey(current.apiKey)
        val deviceId = current.deviceId
        val shouldUpdate = current.isReturningUser || (current.useExistingDeviceId && deviceId.isNotEmpty())

        if (apiKey.isEmpty()) {
            _state.update { it.copy(errorMessage = "Please enter your API key.") }
            return
        }
        if ((current.isReturningUser || current.useExistingDeviceId) && deviceId.isEmpty()) {
            _state.update { it.copy(errorMessage = "Please enter your Device ID.") }
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, errorMessage = null) }
            try {
                val fcmToken = getFcmTokenOrNull()
                val collectedSimInfo = SimInfoCollectionDTO().apply {
                    lastUpdated = System.currentTimeMillis()
                    sims = TextBeeUtils.collectSimInfo(context)
                }
                val input = RegisterDeviceInputDTO().apply {
                    if (!fcmToken.isNullOrBlank()) {
                        this.fcmToken = fcmToken
                    }
                    enabled = true
                    brand = Build.BRAND
                    manufacturer = Build.MANUFACTURER
                    model = Build.MODEL
                    buildId = Build.ID
                    os = TextBeeUtils.getDeviceOsVersion()
                    appVersionCode = BuildConfig.VERSION_CODE
                    appVersionName = BuildConfig.VERSION_NAME
                    name = current.deviceName.ifEmpty { "${Build.BRAND} ${Build.MODEL}" }
                    simInfo = collectedSimInfo
                }

                val response = if (shouldUpdate) {
                    ApiManagerKt.getApiService().updateDevice(deviceId, apiKey, input)
                } else {
                    ApiManagerKt.getApiService().registerDevice(apiKey, input)
                }

                if (response.isSuccessful) {
                    val data = response.body()?.data
                        ?: throw IllegalStateException("missing_response")
                    val registeredId = stringValue(data["_id"]) ?: stringValue(data["id"])
                        ?: throw IllegalStateException("missing_id")
                    val heartbeatInterval = intValue(data["heartbeatIntervalMinutes"], 30)
                    val name = stringValue(data["name"]) ?: ""

                    SharedPreferenceHelper.setSharedPreferenceString(
                        context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, registeredId
                    )
                    SharedPreferenceHelper.setSharedPreferenceString(
                        context, AppConstants.SHARED_PREFS_API_KEY_KEY, apiKey
                    )
                    SharedPreferenceHelper.setSharedPreferenceInt(
                        context, AppConstants.SHARED_PREFS_HEARTBEAT_INTERVAL_MINUTES_KEY, heartbeatInterval
                    )
                    val resolvedName = name.ifEmpty { current.deviceName }
                    SharedPreferenceHelper.setSharedPreferenceString(
                        context, AppConstants.SHARED_PREFS_DEVICE_NAME_KEY, resolvedName
                    )
                    SharedPreferenceHelper.setSharedPreferenceBoolean(
                        context, AppConstants.SHARED_PREFS_GATEWAY_ENABLED_KEY, true
                    )
                    val heartbeatWarning = scheduleHeartbeatBestEffort(context)

                    val fcmWarning = if (fcmToken.isNullOrBlank()) {
                        "Device registered, but this phone has not returned a Firebase push token yet. Keep the app open and make sure Google Play services is installed or updated."
                    } else {
                        null
                    }
                    val warning = listOfNotNull(fcmWarning, heartbeatWarning)
                        .takeIf { it.isNotEmpty() }
                        ?.joinToString(" ")

                    _state.update {
                        it.copy(
                            isLoading = false,
                            registeredDeviceId = registeredId,
                            registeredDeviceName = resolvedName,
                            registrationWarning = warning
                        )
                    }
                    _registrationSuccess.send(Unit)
                } else {
                    val registrationEndpoint = "${BuildConfig.API_BASE_URL}gateway/devices"
                    _state.update {
                        it.copy(
                            isLoading = false,
                            errorMessage = when (response.code()) {
                                401 -> "Invalid API key. Go back and check your key."
                                404 -> if (shouldUpdate) {
                                    "Device ID not found. Verify it in your dashboard."
                                } else {
                                    "Device registration endpoint not found at $registrationEndpoint. Installed app: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})."
                                }
                                429 -> response.serverErrorMessage()
                                    ?: "You've reached your plan's device limit. Disable or remove another device, or upgrade your plan."
                                in 500..599 -> "Server error. Please try again in a moment."
                                else -> response.serverErrorMessage()
                                    ?: "Request failed (${response.code()}). Please try again."
                            }
                        )
                    }
                }
            } catch (e: Exception) {
                TextBeeUtils.logException(e, "Onboarding device registration failed")
                _state.update { it.copy(isLoading = false, errorMessage = registrationErrorMessage(e)) }
            }
        }
    }

    private suspend fun getFcmToken(): String = suspendCoroutine { cont ->
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                if (token.isBlank()) {
                    cont.resumeWithException(IllegalStateException("fcm_token_failed:blank"))
                } else {
                    cont.resume(token)
                }
            }
            .addOnFailureListener { e ->
                cont.resumeWithException(
                    IllegalStateException("fcm_token_failed:${e.message}", e)
                )
            }
    }

    private suspend fun getFcmTokenOrNull(): String? {
        return try {
            withTimeoutOrNull(FCM_TOKEN_TIMEOUT_MS) {
                getFcmToken()
            }?.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            Log.w(TAG, "FCM token unavailable during registration: ${e.message}")
            null
        }
    }

    private fun extractApiKey(rawValue: String): String {
        val trimmed = rawValue.trim()
        if (trimmed.isBlank()) return ""

        val withoutBearer = trimmed.removePrefix("Bearer ").removePrefix("bearer ").trim()

        try {
            val json = JSONObject(withoutBearer)
            for (key in listOf("apiKey", "api_key", "key", "token", "x-api-key")) {
                val value = json.optString(key).trim()
                if (value.isNotBlank()) return value
            }
        } catch (_: Exception) {
            // Not JSON.
        }

        try {
            val uri = Uri.parse(withoutBearer)
            if (!uri.scheme.isNullOrBlank() || !uri.query.isNullOrBlank()) {
                for (key in listOf("apiKey", "api_key", "key", "token", "x-api-key")) {
                    val value = uri.getQueryParameter(key)?.trim()
                    if (!value.isNullOrBlank()) return value
                }
            }
        } catch (_: Exception) {
            // Not a URI.
        }

        return withoutBearer
    }

    private fun scheduleHeartbeatBestEffort(context: Context): String? {
        return try {
            HeartbeatManager.scheduleHeartbeat(context)
            null
        } catch (e: Exception) {
            Log.w(TAG, "Device registered, but heartbeat scheduling failed: ${e.message}", e)
            TextBeeUtils.logException(e, "Onboarding heartbeat scheduling failed after registration")
            "Device registered, but the background heartbeat could not be scheduled yet. Open the app after setup or reboot the phone if the dashboard does not show it online."
        }
    }

    private fun stringValue(value: Any?): String? {
        return when (value) {
            is String -> value
            null -> null
            else -> value.toString()
        }?.trim()?.takeIf { it.isNotBlank() }
    }

    private fun intValue(value: Any?, defaultValue: Int): Int {
        return when (value) {
            is Number -> value.toInt()
            is String -> value.toDoubleOrNull()?.toInt()
            else -> null
        } ?: defaultValue
    }

    private fun registrationErrorMessage(e: Exception): String {
        val detail = exceptionDetail(e)
        return when {
            e.message == "missing_response" ->
                "The server accepted the request but did not return device details. Please try again. ($detail)"
            e.message == "missing_id" ->
                "The server response did not include a Device ID. Please try again. ($detail)"
            e.hasCause<SSLException>() ||
                e.hasText("SSLHandshake") ||
                e.hasText("CertPathValidator") ||
                e.hasText("Trust anchor") ->
                "Secure connection failed. Check the phone date/time and update Android or Google Play services, then retry. ($detail)"
            e.hasCause<UnknownHostException>() || e.hasText("Unable to resolve host") ->
                "Can't find ${BuildConfig.API_BASE_URL}. Check Wi-Fi/mobile data or private DNS, then retry. ($detail)"
            e.hasCause<SocketTimeoutException>() || e.hasText("timeout") ->
                "Connection to ${BuildConfig.API_BASE_URL} timed out. Check the phone internet connection and retry. ($detail)"
            e.hasCause<IOException>() || e.hasText("connect") ->
                "Can't reach ${BuildConfig.API_BASE_URL}. Check the phone internet connection and retry. ($detail)"
            e.hasText("Json") || e.hasText("Expected") ->
                "The server response could not be read by this Android build. Please retry and share this detail: $detail"
            else ->
                "Registration failed. Please retry and share this detail: $detail"
        }
    }

    private fun exceptionDetail(e: Throwable): String {
        val rawMessage = e.message?.trim()?.takeIf { it.isNotBlank() }
            ?: e.cause?.message?.trim()?.takeIf { it.isNotBlank() }
            ?: "no message"
        return "${e.javaClass.simpleName}: ${rawMessage.take(140)}"
    }

    private inline fun <reified T : Throwable> Throwable.hasCause(): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (current is T) return true
            current = current.cause
        }
        return false
    }

    private fun Throwable.hasText(text: String): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (current.javaClass.simpleName.contains(text, ignoreCase = true) ||
                current.message?.contains(text, ignoreCase = true) == true) {
                return true
            }
            current = current.cause
        }
        return false
    }
}
