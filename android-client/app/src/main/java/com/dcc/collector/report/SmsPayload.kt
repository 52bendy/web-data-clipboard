package com.dcc.collector.report

import org.json.JSONObject

/**
 * Request body for POST /api/v1/collect (PRD §4.1.1).
 *
 * `client_message_id` is an extra, backend-ignored field used by the local
 * retry queue to avoid enqueueing the same SMS twice.
 */
data class SmsPayload(
    val deviceId: String,
    val deviceName: String,
    val sender: String,
    val rawContent: String,
    val timestamp: Long,
    val clientMessageId: String,
    val platform: String = "android",
) {

    fun toJson(): JSONObject = JSONObject().apply {
        put("device_id", deviceId)
        put("device_name", deviceName)
        put("platform", platform)
        put("sender", sender)
        put("raw_content", rawContent)
        put("timestamp", timestamp)
        put("client_message_id", clientMessageId)
    }
}
