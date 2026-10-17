package com.dcc.clipboard.network

import com.dcc.clipboard.data.ClientConfig
import com.dcc.clipboard.data.ConfigValidator
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Blocking HTTP client for the collect endpoint. Callers must invoke it off the main thread.
 */
class TestConnectionClient(
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 15_000,
) {
    fun test(
        config: ClientConfig,
        deviceId: String,
        timestamp: Long = System.currentTimeMillis(),
    ): TestConnectionResult {
        val endpoint = buildEndpoint(config.serverUrl)
            ?: return TestConnectionResult.NetworkError("Invalid server URL")

        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-DCC-Token", config.apiToken)
            }

            val payload = CollectRequestFactory
                .buildJson(config, deviceId, timestamp)
                .toByteArray(Charsets.UTF_8)
            // Buffered (not streaming) output keeps HttpURLConnection's error stream readable
            // for 401 responses instead of throwing HttpRetryException.
            connection.outputStream.use { output -> output.write(payload) }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { reader -> reader.readText() }
                .orEmpty()

            CollectResponseParser.parse(status, responseBody)
        } catch (exception: IOException) {
            TestConnectionResult.NetworkError(exception.message)
        } catch (exception: RuntimeException) {
            TestConnectionResult.NetworkError(exception.message)
        } finally {
            connection?.disconnect()
        }
    }

    companion object {
        fun buildEndpoint(serverUrl: String): String? {
            val baseUrl = ConfigValidator.normalizeServerUrl(serverUrl) ?: return null
            return "$baseUrl/api/v1/collect"
        }
    }
}
