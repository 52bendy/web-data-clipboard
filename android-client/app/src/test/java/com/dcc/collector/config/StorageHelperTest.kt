package com.dcc.collector.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageHelperTest {

    @Test
    fun `https server urls are accepted`() {
        assertTrue(StorageHelper.isValidServerUrl("https://dcc.example.com"))
        assertTrue(StorageHelper.isValidServerUrl("https://dcc.example.com:8443/base"))
    }

    @Test
    fun `public plain http urls are rejected`() {
        assertFalse(StorageHelper.isValidServerUrl("http://dcc.example.com"))
        assertFalse(StorageHelper.isValidServerUrl("ftp://dcc.example.com"))
    }

    @Test
    fun `local development hosts may use http`() {
        assertTrue(StorageHelper.isValidServerUrl("http://localhost:3000"))
        assertTrue(StorageHelper.isValidServerUrl("http://127.0.0.1:3000"))
        assertTrue(StorageHelper.isValidServerUrl("http://10.0.2.2:3000"))
    }

    @Test
    fun `malformed and blank values are rejected`() {
        assertFalse(StorageHelper.isValidServerUrl(""))
        assertFalse(StorageHelper.isValidServerUrl("not a url"))
        assertFalse(StorageHelper.isValidServerUrl("https://"))
    }

    @Test
    fun `trailing slashes are removed when normalizing`() {
        assertEquals("https://dcc.example.com", StorageHelper.normalizeBaseUrl(" https://dcc.example.com/ "))
    }
}
