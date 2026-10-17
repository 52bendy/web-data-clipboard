package com.dcc.collector.config

import android.content.Context
import android.content.SharedPreferences
import java.net.URI
import java.util.UUID

/**
 * SharedPreferences-backed configuration (PRD §3 / §5.3).
 *
 * The device id is generated once and kept stable; the backend uses it as the
 * device registry key (REQ-202610-1257).
 */
class StorageHelper(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "").orEmpty().trim()
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, normalizeBaseUrl(value)).apply()
        }

    var apiToken: String
        get() = prefs.getString(KEY_API_TOKEN, "").orEmpty().trim()
        set(value) {
            prefs.edit().putString(KEY_API_TOKEN, value.trim()).apply()
        }

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "").orEmpty().trim()
        set(value) {
            prefs.edit().putString(KEY_DEVICE_NAME, value.trim()).apply()
        }

    var collectionEnabled: Boolean
        get() = prefs.getBoolean(KEY_COLLECTION_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_COLLECTION_ENABLED, value).apply()
        }

    /** Stable id matching the backend's `[A-Za-z0-9._:@-]{1,128}` rule. */
    val deviceId: String
        get() {
            val existing = prefs.getString(KEY_DEVICE_ID, null)
            if (!existing.isNullOrBlank()) {
                return existing
            }
            val generated = "android-${UUID.randomUUID()}"
            prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
            return generated
        }

    val isConfigured: Boolean
        get() = isValidServerUrl(serverUrl) && apiToken.isNotBlank() && deviceName.isNotBlank()

    fun save(serverUrl: String, apiToken: String, deviceName: String) {
        prefs.edit()
            .putString(KEY_SERVER_URL, normalizeBaseUrl(serverUrl))
            .putString(KEY_API_TOKEN, apiToken.trim())
            .putString(KEY_DEVICE_NAME, deviceName.trim())
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "dcc_config"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_API_TOKEN = "api_token"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_COLLECTION_ENABLED = "collection_enabled"

        /** Plain HTTP is tolerated only for local development hosts. */
        private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1", "10.0.2.2")

        fun normalizeBaseUrl(value: String): String = value.trim().trimEnd('/')

        fun isValidServerUrl(value: String): Boolean {
            val candidate = value.trim()
            if (candidate.isEmpty()) {
                return false
            }
            return try {
                val uri = URI(candidate)
                val scheme = uri.scheme?.lowercase()
                val host = uri.host
                if (scheme != "http" && scheme != "https") {
                    return false
                }
                if (host.isNullOrBlank()) {
                    return false
                }
                scheme == "https" || LOOPBACK_HOSTS.contains(host.lowercase())
            } catch (_: Exception) {
                false
            }
        }
    }
}
