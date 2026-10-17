package com.dcc.clipboard.sms

import android.content.Context

/** SharedPreferences persistence for [SmsDeduplicator]; survives process restarts. */
class SharedPreferencesDedupStore(context: Context) : DedupStore {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun read(): String? = prefs.getString(KEY_SEEN, null)

    override fun write(value: String) {
        prefs.edit().putString(KEY_SEEN, value).apply()
    }

    private companion object {
        const val PREFS_NAME = "dcc_sms_dedup"
        const val KEY_SEEN = "seen_fingerprints"
    }
}
