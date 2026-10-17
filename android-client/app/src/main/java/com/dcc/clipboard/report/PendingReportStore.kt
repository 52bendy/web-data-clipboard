package com.dcc.clipboard.report

import android.content.Context
import org.json.JSONArray

/**
 * Small persistent queue for reports that could not be delivered.
 *
 * REQ-202610-1265 owns the full retry/backoff worker; this store is the hand
 * off point so a failed report is not lost when the receiver process ends.
 * Entries are capped to avoid unbounded storage of sensitive content
 * (PRD §8.2: local zero-retention after successful upload).
 */
class PendingReportStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun enqueue(payload: SmsPayload) {
        val queue = readQueue()
        for (index in 0 until queue.length()) {
            if (queue.optJSONObject(index)?.optString(KEY_CLIENT_ID) == payload.clientMessageId) {
                return
            }
        }
        queue.put(payload.toJson())
        while (queue.length() > MAX_ENTRIES) {
            queue.remove(0)
        }
        prefs.edit().putString(KEY_QUEUE, queue.toString()).apply()
    }

    fun size(): Int = readQueue().length()

    @Synchronized
    fun clear() {
        prefs.edit().remove(KEY_QUEUE).apply()
    }

    private fun readQueue(): JSONArray = try {
        JSONArray(prefs.getString(KEY_QUEUE, "[]"))
    } catch (_: Exception) {
        JSONArray()
    }

    private companion object {
        const val PREFS_NAME = "dcc_pending_reports"
        const val KEY_QUEUE = "queue"
        const val KEY_CLIENT_ID = "client_message_id"
        const val MAX_ENTRIES = 50
    }
}
