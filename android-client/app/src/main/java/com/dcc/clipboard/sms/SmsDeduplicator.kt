package com.dcc.clipboard.sms

/** Persistence seam so the deduplication rules stay JVM-testable. */
interface DedupStore {
    fun read(): String?
    fun write(value: String)
}

/**
 * Remembers recently reported SMS fingerprints for a bounded time window.
 *
 * The window only has to cover redeliveries of the same broadcast (seconds to
 * minutes); 5 minutes is deliberately short so a user who genuinely receives
 * the same text twice an hour later still gets two reports. The store keeps
 * at most [maxEntries] fingerprints to bound SharedPreferences growth.
 */
class SmsDeduplicator(
    private val store: DedupStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val windowMillis: Long = DEFAULT_WINDOW_MILLIS,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
) {

    @Synchronized
    fun isDuplicate(fingerprint: String): Boolean {
        require(fingerprint.isNotBlank()) { "fingerprint must not be blank" }
        val now = clock()
        val entries = decode(store.read())
            .filter { now - it.seenAtMillis <= windowMillis }
            .toMutableList()

        val duplicate = entries.any { it.fingerprint == fingerprint }
        if (!duplicate) {
            entries.add(Entry(fingerprint, now))
            while (entries.size > maxEntries) {
                entries.removeAt(0)
            }
        }
        store.write(encode(entries))
        return duplicate
    }

    private data class Entry(val fingerprint: String, val seenAtMillis: Long)

    private fun decode(raw: String?): List<Entry> {
        if (raw.isNullOrBlank()) {
            return emptyList()
        }
        return raw.split(ENTRY_SEPARATOR).mapNotNull { part ->
            val fields = part.split(FIELD_SEPARATOR, limit = 2)
            if (fields.size != 2) {
                return@mapNotNull null
            }
            val seenAt = fields[1].toLongOrNull() ?: return@mapNotNull null
            if (fields[0].isBlank()) {
                return@mapNotNull null
            }
            Entry(fields[0], seenAt)
        }
    }

    private fun encode(entries: List<Entry>): String =
        entries.joinToString(ENTRY_SEPARATOR) { "${it.fingerprint}$FIELD_SEPARATOR${it.seenAtMillis}" }

    companion object {
        const val DEFAULT_WINDOW_MILLIS: Long = 5 * 60 * 1000L
        const val DEFAULT_MAX_ENTRIES: Int = 100
        private const val ENTRY_SEPARATOR = ";"
        private const val FIELD_SEPARATOR = ":"
    }
}
