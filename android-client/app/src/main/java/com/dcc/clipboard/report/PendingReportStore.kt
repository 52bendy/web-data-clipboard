package com.dcc.clipboard.report

import android.content.Context
import android.util.Log
import org.json.JSONArray

class PendingReportStore(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun enqueue(payload: SmsPayload) {
        val queue = readQueue()
        if ((0 until queue.length()).any { queue.optJSONObject(it)?.optString(KEY_CLIENT_ID) == payload.clientMessageId }) {
            return
        }
        queue.put(payload.toJson())
        while (queue.length() > MAX_ENTRIES) {
            queue.remove(0)
            Log.w(TAG, "report.queue_evicted_oldest")
        }
        writeQueue(queue)
    }

    @Synchronized
    fun snapshot(): List<SmsPayload> = readQueue().toPayloads()

    @Synchronized
    fun get(clientMessageId: String): SmsPayload? = readQueue().toPayloads()
        .firstOrNull { it.clientMessageId == clientMessageId }

    @Synchronized
    fun remove(clientMessageId: String) {
        val queue = readQueue()
        val retained = JSONArray()
        for (index in 0 until queue.length()) {
            val item = queue.optJSONObject(index) ?: continue
            if (item.optString(KEY_CLIENT_ID) != clientMessageId) retained.put(item)
        }
        writeQueue(retained)
    }

    @Synchronized
    fun clear() {
        prefs.edit().remove(KEY_QUEUE).apply()
    }

    @Synchronized
    fun size(): Int = readQueue().length()

    private fun JSONArray.toPayloads(): List<SmsPayload> = buildList {
        for (index in 0 until length()) {
            optJSONObject(index)?.let { json ->
                runCatching { SmsPayload.fromJson(json) }.getOrNull()?.let(::add)
            }
        }
    }

    private fun readQueue(): JSONArray = try {
        JSONArray(prefs.getString(KEY_QUEUE, "[]"))
    } catch (_: Exception) {
        JSONArray()
    }

    private fun writeQueue(queue: JSONArray) {
        if (queue.length() == 0) prefs.edit().remove(KEY_QUEUE).apply()
        else prefs.edit().putString(KEY_QUEUE, queue.toString()).apply()
    }

    private companion object {
        const val TAG = "DccPendingReports"
        const val PREFS_NAME = "dcc_pending_reports"
        const val KEY_QUEUE = "queue"
        const val KEY_CLIENT_ID = "client_message_id"
        const val MAX_ENTRIES = 100
    }
}
