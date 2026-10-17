package com.dcc.clipboard.service

import android.app.NotificationManager
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.WorkManagerTestInitHelper
import com.dcc.clipboard.MainActivity
import com.dcc.clipboard.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DccForegroundServiceTest {
    @Test
    fun `service posts low importance ongoing notification and is sticky`() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            ApplicationProvider.getApplicationContext(),
        )
        val controller = Robolectric.buildService(DccForegroundService::class.java).create()
        val service = controller.get()
        controller.startCommand(0, 1)
        val result = service.onStartCommand(Intent(), 0, 1)
        val serviceShadow = shadowOf(service)
        val notification = serviceShadow.lastForegroundNotification
        val manager = ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(NotificationManager::class.java)
        val channel = manager.getNotificationChannel(DccForegroundService.CHANNEL_ID)

        assertEquals(android.app.Service.START_STICKY, result)
        assertNotNull(notification)
        assertTrue(notification.extras.getCharSequence("android.title").toString().contains("数据采集中心"))
        assertTrue(notification.extras.getCharSequence("android.text").toString().contains("数据采集中心后台服务运行中…"))
        assertTrue(notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
        assertEquals(MainActivity::class.java.name, shadowOf(notification.contentIntent).savedIntent.component?.className)
        controller.destroy()
    }
}
