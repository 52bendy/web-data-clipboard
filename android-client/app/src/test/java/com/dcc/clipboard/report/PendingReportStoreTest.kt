package com.dcc.clipboard.report

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PendingReportStoreTest {
    private lateinit var context: Context
    private lateinit var store: PendingReportStore

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        store = PendingReportStore(context)
        store.clear()
    }

    @Test
    fun `enqueue deduplicates and supports get remove clear and size`() {
        val first = payload("first")
        store.enqueue(first)
        store.enqueue(first.copy(rawContent = "duplicate"))
        store.enqueue(payload("second"))

        assertEquals(2, store.size())
        assertEquals(first, store.get("first"))
        store.remove("first")
        assertNull(store.get("first"))
        assertEquals(1, store.size())
        store.clear()
        assertEquals(0, store.size())
    }

    @Test
    fun `queue is capped at one hundred oldest reports`() {
        repeat(101) { store.enqueue(payload("id-$it")) }

        assertEquals(100, store.size())
        assertNull(store.get("id-0"))
        assertEquals("id-1", store.snapshot().first().clientMessageId)
        assertEquals("id-100", store.snapshot().last().clientMessageId)
    }

    @Test
    fun `clear removes raw content from shared preferences`() {
        store.enqueue(payload("private", "private message"))
        val preferences = context.getSharedPreferences("dcc_pending_reports", Context.MODE_PRIVATE)
        assertTrue(preferences.getString("queue", "").orEmpty().contains("raw_content"))

        store.clear()

        assertNull(preferences.getString("queue", null))
        assertFalse(preferences.all.values.any { it.toString().contains("private message") })
    }

    private fun payload(id: String, content: String = "body-$id") = SmsPayload(
        deviceId = "device-1",
        deviceName = "Test device",
        sender = "+15551234567",
        rawContent = content,
        timestamp = 1_700_000_000_000,
        clientMessageId = id,
    )
}
