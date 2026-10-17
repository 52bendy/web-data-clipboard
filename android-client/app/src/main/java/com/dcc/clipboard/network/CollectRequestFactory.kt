package com.dcc.clipboard.network

import com.dcc.clipboard.data.ClientConfig
import org.json.JSONObject

/**
 * Builds the simulated report used by the "test connection" action. It intentionally goes
 * through the real collect endpoint so a successful test proves both reachability and token
 * validity, and exercises code extraction end to end.
 */
object CollectRequestFactory {
    const val TEST_SENDER = "DCC-Test"
    const val TEST_CONTENT = "【网络剪切板】测试连接验证码：123456，5 分钟内有效。"

    fun buildJson(config: ClientConfig, deviceId: String, timestamp: Long): String {
        val payload = JSONObject().apply {
            put("device_id", deviceId)
            put("device_name", config.deviceName)
            put("platform", "android")
            put("sender", TEST_SENDER)
            put("raw_content", TEST_CONTENT)
            put("timestamp", timestamp)
        }
        return payload.toString()
    }
}
