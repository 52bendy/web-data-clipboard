package com.dcc.clipboard.data

/**
 * Persisted connection settings for this device.
 *
 * [serverUrl] is stored in normalized form (scheme + host + optional path, no trailing slash).
 */
data class ClientConfig(
    val serverUrl: String = "",
    val apiToken: String = "",
    val deviceName: String = "",
    val serviceEnabled: Boolean = false,
)
