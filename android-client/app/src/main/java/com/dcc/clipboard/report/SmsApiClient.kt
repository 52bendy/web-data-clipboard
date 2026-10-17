package com.dcc.clipboard.report

import android.util.Log
import com.dcc.clipboard.data.ConfigValidator
import com.dcc.clipboard.data.StorageHelper
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

data class UploadResult(
    val success: Boolean,
    val statusCode: Int,
    val detail: String,
)

class SmsApiClient(
    private val storage: StorageHelper,
    private val client: OkHttpClient = defaultClient,
) {
    fun execute(payload: SmsPayload): UploadResult {
        val config = storage.loadConfig()
        if (!ConfigValidator.validate(config.serverUrl, config.apiToken, config.deviceName).isValid) {
            return UploadResult(false, 0, "configuration incomplete")
        }
        val request = buildRequest(payload, config.serverUrl, config.apiToken)
        return try {
            client.newCall(request).execute().use { response ->
                UploadResult(
                    success = response.isSuccessful,
                    statusCode = response.code,
                    detail = if (response.isSuccessful) "ok" else "HTTP ${response.code}",
                )
            }
        } catch (error: IOException) {
            Log.w(TAG, "sms.upload_failed type=${error.javaClass.simpleName}")
            UploadResult(false, 0, "network error")
        } catch (error: Exception) {
            Log.w(TAG, "sms.upload_failed type=${error.javaClass.simpleName}")
            UploadResult(false, 0, "upload failed")
        }
    }

    fun enqueue(payload: SmsPayload, callback: (UploadResult) -> Unit): Call? {
        val config = storage.loadConfig()
        if (!ConfigValidator.validate(config.serverUrl, config.apiToken, config.deviceName).isValid) {
            callback(UploadResult(false, 0, "configuration incomplete"))
            return null
        }
        val request = buildRequest(payload, config.serverUrl, config.apiToken)
        return client.newCall(request).also { call ->
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    Log.w(TAG, "sms.upload_failed type=${e.javaClass.simpleName}")
                    callback(UploadResult(false, 0, "network error"))
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        callback(
                            UploadResult(
                                success = response.isSuccessful,
                                statusCode = response.code,
                                detail = if (response.isSuccessful) "ok" else "HTTP ${response.code}",
                            ),
                        )
                    }
                }
            })
        }
    }

    private fun buildRequest(payload: SmsPayload, serverUrl: String, apiToken: String): Request =
        Request.Builder()
            .url("$serverUrl/api/v1/collect")
            .header("X-DCC-Token", apiToken)
            .header("Content-Type", "application/json; charset=utf-8")
            .post(payload.toJson().toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

    companion object {
        private const val TAG = "DccSmsApiClient"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .build()
    }
}
