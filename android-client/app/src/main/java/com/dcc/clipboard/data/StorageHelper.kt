package com.dcc.clipboard.data

import android.content.Context
import androidx.core.content.edit
import java.util.UUID

/**
 * SharedPreferences-backed persistence for the connection form and the stable device identity.
 */
class StorageHelper(context: Context) {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun loadConfig(): ClientConfig = ClientConfig(
        serverUrl = preferences.getString(KEY_SERVER_URL, "").orEmpty(),
        apiToken = preferences.getString(KEY_API_TOKEN, "").orEmpty(),
        deviceName = preferences.getString(KEY_DEVICE_NAME, "").orEmpty(),
        serviceEnabled = preferences.getBoolean(KEY_SERVICE_ENABLED, false),
    )

    fun saveConfig(config: ClientConfig) {
        preferences.edit {
            putString(KEY_SERVER_URL, config.serverUrl)
            putString(KEY_API_TOKEN, config.apiToken)
            putString(KEY_DEVICE_NAME, config.deviceName)
            putBoolean(KEY_SERVICE_ENABLED, config.serviceEnabled)
        }
    }

    fun setServiceEnabled(enabled: Boolean) {
        preferences.edit { putBoolean(KEY_SERVICE_ENABLED, enabled) }
    }

    /**
     * Device ids are generated once and reused. The format matches the collect API contract
     * (`A-Za-z0-9._:@-`, max 128 characters).
     */
    fun getOrCreateDeviceId(): String {
        preferences.getString(KEY_DEVICE_ID, null)?.let { return it }
        val generated = "android_" + UUID.randomUUID().toString().replace("-", "").take(24)
        preferences.edit { putString(KEY_DEVICE_ID, generated) }
        return generated
    }

    fun wasPermissionRequested(): Boolean =
        preferences.getBoolean(KEY_PERMISSION_REQUESTED, false)

    fun markPermissionRequested() {
        preferences.edit { putBoolean(KEY_PERMISSION_REQUESTED, true) }
    }

    fun clear() {
        preferences.edit { clear() }
    }

    companion object {
        const val PREFERENCES_NAME = "dcc_client_config"

        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_API_TOKEN = "api_token"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_SERVICE_ENABLED = "service_enabled"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PERMISSION_REQUESTED = "sms_permission_requested"
    }
}
