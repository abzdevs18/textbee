package com.vernu.sms.ui.messages

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.vernu.sms.ApiManagerKt
import com.vernu.sms.AppConstants
import com.vernu.sms.dtos.SmsMessage
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.outbox.OutboxEntry
import com.vernu.sms.outbox.OutboxStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class MessagesState(
    val messages: List<SmsMessage> = emptyList(),
    /** This phone's own view of each SMS (queued / sending / sent), keyed by server SMS id. */
    val localStates: Map<String, OutboxEntry> = emptyMap(),
    val isLoading: Boolean = true,
    val isLoadingMore: Boolean = false,
    val error: String? = null,
    val filter: String = "all",
    val currentPage: Int = 1,
    val totalPages: Int = 1,
    val total: Int = 0
)

class MessagesViewModel(app: Application) : AndroidViewModel(app) {
    companion object {
        private const val REFRESH_DEBOUNCE_MS = 1500L
    }

    private val context get() = getApplication<Application>().applicationContext

    private val _state = MutableStateFlow(MessagesState())
    val state: StateFlow<MessagesState> = _state.asStateFlow()

    init {
        fetchMessages(reset = true)
    }

    fun setFilter(filter: String) {
        _state.update { it.copy(filter = filter, currentPage = 1) }
        fetchMessages(reset = true)
    }

    fun refresh() = fetchMessages(reset = true)

    private var pendingRefresh: Job? = null

    /**
     * Coalesces bursts of outbox change broadcasts (accept, submit, sent,
     * delivered for every SMS) into one reload.
     */
    fun refreshSoon() {
        pendingRefresh?.cancel()
        pendingRefresh = viewModelScope.launch {
            delay(REFRESH_DEBOUNCE_MS)
            fetchMessages(reset = true)
        }
    }

    fun loadMore() {
        val s = _state.value
        if (s.isLoadingMore || s.currentPage >= s.totalPages) return
        _state.update { it.copy(currentPage = it.currentPage + 1) }
        fetchMessages(reset = false)
    }

    private fun fetchMessages(reset: Boolean) {
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        if (apiKey.isEmpty() || deviceId.isEmpty()) {
            _state.update { it.copy(isLoading = false, error = "Device not connected") }
            return
        }

        val page = if (reset) 1 else _state.value.currentPage
        val filter = _state.value.filter

        viewModelScope.launch {
            if (reset) {
                _state.update { it.copy(isLoading = true, error = null) }
            } else {
                _state.update { it.copy(isLoadingMore = true) }
            }
            try {
                val response = ApiManagerKt.getApiService()
                    .getMessages(deviceId, apiKey, page, 20, filter)
                if (response.isSuccessful) {
                    val body = response.body()
                    val newMessages = body?.data ?: emptyList()
                    val meta = body?.meta
                    val combined = if (reset) newMessages else _state.value.messages + newMessages
                    val localStates = loadLocalStates(combined)
                    _state.update {
                        it.copy(
                            messages = combined,
                            localStates = localStates,
                            isLoading = false,
                            isLoadingMore = false,
                            error = null,
                            currentPage = page,
                            totalPages = meta?.totalPages ?: 1,
                            total = meta?.total ?: 0
                        )
                    }
                } else {
                    _state.update {
                        it.copy(isLoading = false, isLoadingMore = false, error = "Failed to load messages")
                    }
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(isLoading = false, isLoadingMore = false, error = "Network error")
                }
            }
        }
    }

    private suspend fun loadLocalStates(messages: List<SmsMessage>): Map<String, OutboxEntry> {
        val ids = messages.filter { !it.isReceived }.mapNotNull { it.id }
        if (ids.isEmpty()) return emptyMap()
        return withContext(Dispatchers.IO) {
            try {
                OutboxStore.get(context).snapshotsFor(ids)
            } catch (e: Exception) {
                emptyMap()
            }
        }
    }
}
