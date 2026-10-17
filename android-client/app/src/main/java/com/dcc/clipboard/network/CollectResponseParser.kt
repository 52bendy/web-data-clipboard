package com.dcc.clipboard.network

import org.json.JSONException
import org.json.JSONObject

/**
 * Interprets the backend's shared `{code, message, data}` envelope. Kept separate from the
 * HTTP transport so it can be tested without a network.
 */
object CollectResponseParser {
    fun parse(httpStatus: Int, body: String): TestConnectionResult {
        val json = parseJson(body)
        val message = json?.optString("message")?.takeIf { it.isNotBlank() }

        if (httpStatus in 200..299) {
            val code = json?.optInt("code", httpStatus) ?: httpStatus
            if (code == 200) {
                val data = json?.optJSONObject("data")
                return TestConnectionResult.Success(
                    collectionId = data?.stringOrNull("collection_id"),
                    extractedCode = data?.stringOrNull("extracted_code"),
                    clipboardUpdated = data?.optBoolean("clipboard_updated", false) ?: false,
                )
            }
            return TestConnectionResult.Rejected(httpStatus, message)
        }

        return TestConnectionResult.Rejected(httpStatus, message)
    }

    private fun parseJson(body: String): JSONObject? = try {
        JSONObject(body.ifBlank { "{}" })
    } catch (exception: JSONException) {
        null
    }

    private fun JSONObject.stringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
}
