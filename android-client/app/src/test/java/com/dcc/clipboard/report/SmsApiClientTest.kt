package com.dcc.clipboard.report

import androidx.test.core.app.ApplicationProvider
import com.dcc.clipboard.data.ClientConfig
import com.dcc.clipboard.data.StorageHelper
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmsApiClientTest {
    private val server = MockWebServer()
    private lateinit var storage: StorageHelper
    private lateinit var client: SmsApiClient

    @Before
    fun setUp() {
        server.start()
        storage = StorageHelper(ApplicationProvider.getApplicationContext())
        storage.clear()
        storage.saveConfig(
            ClientConfig(
                serverUrl = server.url("/").toString().trimEnd('/'),
                apiToken = "test-token",
                deviceName = "Test device",
            ),
        )
        client = SmsApiClient(storage, OkHttpClient())
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `execute posts expected endpoint headers and JSON payload`() {
        server.enqueue(MockResponse().setResponseCode(200))

        val result = client.execute(payload)

        assertTrue(result.success)
        assertEquals(200, result.statusCode)
        val request = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/api/v1/collect", request.path)
        assertEquals("test-token", request.getHeader("X-DCC-Token"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals("device-1", body.getString("device_id"))
        assertEquals("Test device", body.getString("device_name"))
        assertEquals("+15551234567", body.getString("sender"))
        assertEquals("test message", body.getString("raw_content"))
        assertEquals("message-1", body.getString("client_message_id"))
    }

    @Test
    fun `execute returns a structured failure for HTTP 500`() {
        server.enqueue(MockResponse().setResponseCode(500))

        val result = client.execute(payload)

        assertFalse(result.success)
        assertEquals(500, result.statusCode)
        assertEquals("HTTP 500", result.detail)
    }

    private val payload = SmsPayload(
        deviceId = "device-1",
        deviceName = "Test device",
        sender = "+15551234567",
        rawContent = "test message",
        timestamp = 1_700_000_000_000,
        clientMessageId = "message-1",
    )
}
