package com.dcc.clipboard.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsDeduplicatorTest {

    private class FakeStore(var value: String? = null) : DedupStore {
        override fun read(): String? = value
        override fun write(value: String) {
            this.value = value
        }
    }

    @Test
    fun `first delivery is new and the repeat is a duplicate`() {
        val deduplicator = SmsDeduplicator(FakeStore(), clock = { 1_000L })

        assertFalse(deduplicator.isDuplicate("abc"))
        assertTrue(deduplicator.isDuplicate("abc"))
    }

    @Test
    fun `different fingerprints are independent`() {
        val deduplicator = SmsDeduplicator(FakeStore(), clock = { 1_000L })

        assertFalse(deduplicator.isDuplicate("abc"))
        assertFalse(deduplicator.isDuplicate("def"))
    }

    @Test
    fun `fingerprint is accepted again after the window expires`() {
        var now = 1_000L
        val deduplicator = SmsDeduplicator(
            store = FakeStore(),
            clock = { now },
            windowMillis = 500L,
        )

        assertFalse(deduplicator.isDuplicate("abc"))
        now = 1_500L
        assertTrue(deduplicator.isDuplicate("abc"))
        now = 1_501L
        assertFalse(deduplicator.isDuplicate("abc"))
    }

    @Test
    fun `oldest entry is evicted when the cap is reached`() {
        val deduplicator = SmsDeduplicator(
            store = FakeStore(),
            clock = { 1_000L },
            maxEntries = 2,
        )

        assertFalse(deduplicator.isDuplicate("a"))
        assertFalse(deduplicator.isDuplicate("b"))
        assertFalse(deduplicator.isDuplicate("c"))
        // "a" fell out of the two-entry window, while "b" is still remembered.
        assertTrue(deduplicator.isDuplicate("b"))
        assertFalse(deduplicator.isDuplicate("a"))
    }

    @Test
    fun `state survives a new deduplicator instance`() {
        val store = FakeStore()
        val first = SmsDeduplicator(store, clock = { 1_000L })
        assertFalse(first.isDuplicate("persisted"))

        val second = SmsDeduplicator(store, clock = { 1_000L })
        assertTrue(second.isDuplicate("persisted"))
    }

    @Test
    fun `malformed persisted state is ignored`() {
        val deduplicator = SmsDeduplicator(FakeStore("broken-entry;also:bad:x"), clock = { 1_000L })

        assertFalse(deduplicator.isDuplicate("abc"))
        assertTrue(deduplicator.isDuplicate("abc"))
    }
}
