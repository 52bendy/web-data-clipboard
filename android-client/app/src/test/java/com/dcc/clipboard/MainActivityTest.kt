package com.dcc.clipboard

import android.content.Context
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.dcc.clipboard.data.ClientConfig
import com.dcc.clipboard.data.StorageHelper
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.robolectric.Shadows.shadowOf
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        StorageHelper(context).clear()
    }

    @Test
    fun `saved configuration is echoed when the screen opens`() {
        StorageHelper(context).saveConfig(
            ClientConfig(
                serverUrl = "https://dcc.example.com",
                apiToken = "secret-token",
                deviceName = "Pixel 7",
                serviceEnabled = true,
            ),
        )

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertEquals(
                    "https://dcc.example.com",
                    activity.findViewById<TextInputEditText>(R.id.serverUrlInput).text.toString(),
                )
                assertEquals(
                    "secret-token",
                    activity.findViewById<TextInputEditText>(R.id.apiTokenInput).text.toString(),
                )
                assertEquals(
                    "Pixel 7",
                    activity.findViewById<TextInputEditText>(R.id.deviceNameInput).text.toString(),
                )
                assertTrue(activity.findViewById<MaterialSwitch>(R.id.serviceSwitch).isChecked)
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.deviceIdText).visibility)
            }
        }
    }

    @Test
    fun `valid switch enable starts foreground service and persists enabled state`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<TextInputEditText>(R.id.serverUrlInput).setText("https://dcc.example.com")
                activity.findViewById<TextInputEditText>(R.id.apiTokenInput).setText("token-123")
                activity.findViewById<TextInputEditText>(R.id.deviceNameInput).setText("Test device")
                activity.findViewById<MaterialSwitch>(R.id.serviceSwitch).isChecked = true
                assertTrue(shadowOf(activity).peekNextStartedService().component?.className?.endsWith("DccForegroundService") == true)
                assertTrue(StorageHelper(activity).loadConfig().serviceEnabled)
            }
        }
    }

    @Test
    fun `invalid switch enable reverts and does not persist enabled state`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<MaterialSwitch>(R.id.serviceSwitch).isChecked = true
                assertEquals(false, activity.findViewById<MaterialSwitch>(R.id.serviceSwitch).isChecked)
                assertEquals(false, StorageHelper(activity).loadConfig().serviceEnabled)
                assertEquals(null, shadowOf(activity).peekNextStartedService())
            }
        }
    }

    @Test
    fun `disabling switch stops the foreground service`() {
        StorageHelper(context).saveConfig(
            ClientConfig("https://dcc.example.com", "token", "device", serviceEnabled = true),
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<MaterialSwitch>(R.id.serviceSwitch).isChecked = false
                assertTrue(shadowOf(activity).getNextStoppedService()?.component?.className?.endsWith("DccForegroundService") == true)
                assertEquals(false, StorageHelper(activity).loadConfig().serviceEnabled)
            }
        }
    }

    @Test
    fun `save while enabled reconciles service start`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<TextInputEditText>(R.id.serverUrlInput).setText("https://dcc.example.com")
                activity.findViewById<TextInputEditText>(R.id.apiTokenInput).setText("token")
                activity.findViewById<TextInputEditText>(R.id.deviceNameInput).setText("device")
                activity.findViewById<MaterialSwitch>(R.id.serviceSwitch).isChecked = true
                shadowOf(activity).clearStartedServices()
                activity.findViewById<MaterialButton>(R.id.saveButton).performClick()
                assertTrue(shadowOf(activity).peekNextStartedService()?.component?.className?.endsWith("DccForegroundService") == true)
            }
        }
    }

    @Test
    fun `save button persists the form and normalizes the url`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<TextInputEditText>(R.id.serverUrlInput)
                    .setText("dcc.example.com")
                activity.findViewById<TextInputEditText>(R.id.apiTokenInput)
                    .setText("token-123")
                activity.findViewById<TextInputEditText>(R.id.deviceNameInput)
                    .setText("测试机")
                activity.findViewById<MaterialButton>(R.id.saveButton).performClick()
            }
        }

        val config = StorageHelper(context).loadConfig()
        assertEquals("https://dcc.example.com", config.serverUrl)
        assertEquals("token-123", config.apiToken)
        assertEquals("测试机", config.deviceName)
    }

    @Test
    fun `invalid server url is rejected with a field error`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<TextInputEditText>(R.id.serverUrlInput)
                    .setText("ftp://example.com")
                activity.findViewById<TextInputEditText>(R.id.apiTokenInput)
                    .setText("token-123")
                activity.findViewById<TextInputEditText>(R.id.deviceNameInput)
                    .setText("测试机")
                activity.findViewById<MaterialButton>(R.id.saveButton).performClick()

                val layout = activity.findViewById<TextInputLayout>(R.id.serverUrlLayout)
                assertNotNull(layout.error)
                assertEquals("", StorageHelper(activity).loadConfig().serverUrl)
            }
        }
    }
}
