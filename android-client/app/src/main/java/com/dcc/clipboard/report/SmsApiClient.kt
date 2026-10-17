package com.dcc.clipboard.report

import android.util.Log
import com.dcc.clipboard.data.StorageHelper
import java.net.HttpURLConnection
import java.net.URL

data class UploadResult(
    val success: Boolean,
    val statusCode: Int,
    val detail: String,
)

/**
 * Minimal blocking HTTP client used by the receiver worker. Timeouts are kept
 * short because a broadcast receiver only has ~10 seconds before the system
 * considers it unresponsive; REQ-202610-1265 replaces this with a foreground
 * service and a WorkManager-backed retry queue.
 */
class SmsApiClient(private val storage: StorageHelper) {

    fun upload(payload: SmsPayload): UploadResult {
        val config = storage.loadConfig()
        if (!com.dcc.clipboard.data.ConfigValidator.validate(
                config.serverUrl,
                config.apiToken,
                config.deviceName,
            ).isValid
        ) {
            return UploadResult(false, 0, "configuration incomplete")
        }
        var connection: HttpURLConnection? = null
        return try {
            val endpoint = URL("${config.serverUrl}/api/v1/collect")
            connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MILLIS
                readTimeout = READ_TIMEOUT_MILLIS
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-DCC-Token", config.apiToken)
            }
            val body = payload.toJson().toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { output -> output.write(body) }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            UploadResult(status in 200..299, status, response.take(MAX_DETAIL_LENGTH))
        } catch (error: Exception) {
            Log.w(TAG, "sms.upload_failed", error)
            UploadResult(false, 0, error.message ?: error.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    private companion object {
        const val TAG = "DccSmsApiClient"
        const val CONNECT_TIMEOUT_MILLIS = 4_000
        const val READ_TIMEOUT_MILLIS = 4_000
        const val MAX_DETAIL_LENGTH = 300
    }
}
