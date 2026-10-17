package com.dcc.clipboard.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyConfigCompatibilityTest {
    @Test
    fun `https server urls are accepted`() {
        assertTrue(ConfigValidator.validate("https://dcc.example.com", "token", "device").isValid)
        assertTrue(ConfigValidator.validate("https://dcc.example.com:8443/base", "token", "device").isValid)
    }

    @Test
    fun `public plain http urls are rejected by the shared validator`() {
        assertFalse(ConfigValidator.validate("http://dcc.example.com", "token", "device").isValid)
        assertFalse(ConfigValidator.validate("ftp://dcc.example.com", "token", "device").isValid)
    }

    @Test
    fun `local development hosts may use http`() {
        assertTrue(ConfigValidator.validate("http://localhost:3000", "token", "device").isValid)
        assertTrue(ConfigValidator.validate("http://127.0.0.1:3000", "token", "device").isValid)
        assertTrue(ConfigValidator.validate("http://10.0.2.2:3000", "token", "device").isValid)
    }

    @Test
    fun `malformed and blank values are rejected`() {
        assertFalse(ConfigValidator.validate("", "token", "device").isValid)
        assertFalse(ConfigValidator.validate("not a url", "token", "device").isValid)
        assertFalse(ConfigValidator.validate("https://", "token", "device").isValid)
    }

    @Test
    fun `trailing slashes are removed when normalizing`() {
        assertEquals("https://dcc.example.com", ConfigValidator.normalizeServerUrl(" https://dcc.example.com/ "))
    }
}
