package com.dcc.clipboard.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigValidatorTest {
    @Test
    fun `accepts https url and trims trailing slash`() {
        val result = ConfigValidator.validate(
            serverUrl = " https://dcc.example.com/ ",
            apiToken = " token ",
            deviceName = " Pixel 7 ",
        )

        assertTrue(result.isValid)
        assertEquals("https://dcc.example.com", result.normalizedServerUrl)
    }

    @Test
    fun `adds https scheme when the user omits it`() {
        assertEquals(
            "https://dcc.example.com",
            ConfigValidator.normalizeServerUrl("dcc.example.com"),
        )
    }

    @Test
    fun `allows http only for approved local development hosts`() {
        for (host in listOf("localhost", "127.0.0.1", "[::1]", "10.0.2.2")) {
            assertEquals(
                "http://$host:3000",
                ConfigValidator.normalizeServerUrl("http://$host:3000/"),
            )
        }
        assertNull(ConfigValidator.normalizeServerUrl("http://dcc.example.com"))
    }

    @Test
    fun `keeps reverse proxy path prefix`() {
        assertEquals(
            "https://example.com/dcc",
            ConfigValidator.normalizeServerUrl("https://example.com/dcc/"),
        )
    }

    @Test
    fun `rejects empty server url`() {
        val result = ConfigValidator.validate("", "token", "device")

        assertEquals(ConfigError.SERVER_URL_EMPTY, result.errors[ConfigField.SERVER_URL])
        assertFalse(result.isValid)
    }

    @Test
    fun `rejects unsupported schemes and missing hosts`() {
        assertNull(ConfigValidator.normalizeServerUrl("ftp://example.com"))
        assertNull(ConfigValidator.normalizeServerUrl("https://"))
        assertNull(ConfigValidator.normalizeServerUrl("https://example.com/?token=secret"))
        assertNull(ConfigValidator.normalizeServerUrl("https://user:pass@example.com"))
    }

    @Test
    fun `rejects blank token and device name`() {
        val result = ConfigValidator.validate("https://example.com", "   ", "  ")

        assertEquals(ConfigError.API_TOKEN_EMPTY, result.errors[ConfigField.API_TOKEN])
        assertEquals(ConfigError.DEVICE_NAME_EMPTY, result.errors[ConfigField.DEVICE_NAME])
    }

    @Test
    fun `rejects over long token and device name`() {
        val result = ConfigValidator.validate(
            "https://example.com",
            "a".repeat(ConfigValidator.MAX_TOKEN_LENGTH + 1),
            "名".repeat(ConfigValidator.MAX_DEVICE_NAME_LENGTH + 1),
        )

        assertEquals(ConfigError.API_TOKEN_TOO_LONG, result.errors[ConfigField.API_TOKEN])
        assertEquals(ConfigError.DEVICE_NAME_TOO_LONG, result.errors[ConfigField.DEVICE_NAME])
    }
}
