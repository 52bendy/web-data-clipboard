package com.dcc.clipboard.network

import com.dcc.clipboard.data.ClientConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectRequestFactoryTest {
    @Test
    fun `builds the simulated collect payload required by the backend`() {
        val config = ClientConfig(
            serverUrl = "https://dcc.example.com",
            apiToken = "secret",
            deviceName = "Pixel 7",
            serviceEnabled = true,
        )

        val payload = JSONObject(
            CollectRequestFactory.buildJson(config, "android_device_1", 1_728_950_400_000L),
        )

        assertEquals("android_device_1", payload.getString("device_id"))
        assertEquals("Pixel 7", payload.getString("device_name"))
        assertEquals("android", payload.getString("platform"))
        assertEquals(CollectRequestFactory.TEST_SENDER, payload.getString("sender"))
        assertEquals(CollectRequestFactory.TEST_CONTENT, payload.getString("raw_content"))
        assertEquals(1_728_950_400_000L, payload.getLong("timestamp"))
        assertTrue(payload.getString("raw_content").contains("123456"))
    }
}
