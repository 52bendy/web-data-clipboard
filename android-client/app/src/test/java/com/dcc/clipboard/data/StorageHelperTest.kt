package com.dcc.clipboard.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StorageHelperTest {
    private lateinit var context: Context
    private lateinit var storageHelper: StorageHelper

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        storageHelper = StorageHelper(context)
        storageHelper.clear()
    }

    @Test
    fun `saveConfig persists every field and loadConfig echoes it`() {
        val config = ClientConfig(
            serverUrl = "https://dcc.example.com",
            apiToken = "secret-token",
            deviceName = "Pixel 7",
            serviceEnabled = true,
        )

        storageHelper.saveConfig(config)

        assertEquals(config, storageHelper.loadConfig())
    }

    @Test
    fun `loadConfig returns safe defaults before the first save`() {
        assertEquals(ClientConfig(), storageHelper.loadConfig())
        assertFalse(storageHelper.loadConfig().serviceEnabled)
    }

    @Test
    fun `device id is generated once and stays stable`() {
        val first = storageHelper.getOrCreateDeviceId()
        val second = storageHelper.getOrCreateDeviceId()

        assertEquals(first, second)
        assertTrue(first.startsWith("android_"))
        assertTrue(first.length <= 128)
        assertTrue(first.matches(Regex("[A-Za-z0-9._:@-]+")))
    }

    @Test
    fun `service switch and permission marker persist independently`() {
        storageHelper.setServiceEnabled(true)
        storageHelper.markPermissionRequested()

        assertTrue(storageHelper.loadConfig().serviceEnabled)
        assertTrue(storageHelper.wasPermissionRequested())
    }
}
