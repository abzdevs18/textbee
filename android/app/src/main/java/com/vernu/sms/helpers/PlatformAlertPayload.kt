package com.vernu.sms.helpers

import java.net.URI

/** A small notification envelope; deliberately contains no arbitrary request data. */
data class PlatformAlertPayload(
    val id: String, val title: String, val body: String, val severity: String,
    val url: String?, val issuedAt: Long
) {
    companion object {
        fun parse(data: Map<String, String>, now: Long): PlatformAlertPayload? {
            if (data["type"] != "platform_alert") return null
            val id = data["alertId"]?.takeIf { it.matches(Regex("^[a-zA-Z0-9_-]{1,128}$")) } ?: return null
            val title = data["title"]?.takeIf { it.isNotBlank() && it.length <= 160 } ?: return null
            val body = data["body"]?.takeIf { it.isNotBlank() && it.length <= 320 } ?: return null
            val severity = data["severity"]?.takeIf { it in setOf("issue", "degraded", "outage", "recovered") } ?: return null
            val issued = data["issuedAt"]?.toLongOrNull() ?: return null
            val expires = data["expiresAt"]?.toLongOrNull() ?: return null
            if (issued <= 0 || issued > now + 60000 || expires <= now || expires <= issued || expires - issued > 900000) return null
            val rawUrl = data["url"]?.takeIf { it.isNotBlank() }
            val url = rawUrl?.takeIf { isSafeUrl(it) }
            if (rawUrl != null && url == null) return null
            return PlatformAlertPayload(id, title, body, severity, url, issued)
        }

        private fun isSafeUrl(value: String): Boolean = try {
            val uri = URI(value)
            value.length <= 1024 && uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null
        } catch (_: Exception) { false }
    }
}
