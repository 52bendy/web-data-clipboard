package com.dcc.clipboard.report

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.NetworkType
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import com.dcc.clipboard.data.ClientConfig
import com.dcc.clipboard.data.StorageHelper
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReportRetryWorkerTest {
    private lateinit var context: Context
    private lateinit var store: PendingReportStore
    private val server = MockWebServer()

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        server.start()
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setMinimumLoggingLevel(android.util.Log.ERROR).build(),
        )
        store = PendingReportStore(context)
        store.clear()
        StorageHelper(context).apply {
            clear()
            saveConfig(
                ClientConfig(
                    serverUrl = server.url("/").toString().trimEnd('/'),
                    apiToken = "test-token",
                    deviceName = "Test device",
                ),
            )
        }
    }

    @After
    fun tearDown() {
        server.shutdown()
        WorkManager.getInstance(context).cancelAllWork().result.get()
    }

    @Test
    fun `successful upload removes queued payload`() {
        val payload = payload("success")
        store.enqueue(payload)
        server.enqueue(MockResponse().setResponseCode(200))

        val result = runWorker(payload.clientMessageId)

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
        assertEquals(0, store.size())
    }

    @Test
    fun `failed upload schedules retry without crashing`() {
        val payload = payload("retry")
        store.enqueue(payload)
        server.enqueue(MockResponse().setResponseCode(500))

        val result = runWorker(payload.clientMessageId)

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
        assertEquals(1, store.size())
        val work = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(ReportScheduler.workName(payload.clientMessageId)).get()
        assertTrue(work.any { !it.state.isFinished })
        assertEquals(NetworkType.CONNECTED, work.last().constraints.requiredNetworkType)
        assertEquals(
            setOf(ReportScheduler.INPUT_CLIENT_MESSAGE_ID),
            ReportRetryWorker.input(payload.clientMessageId).keyValueMap.keys,
        )
    }

    @Test
    fun `missing payload is already complete`() {
        val result = runWorker("absent")

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
        assertEquals(0, store.size())
    }

    private fun runWorker(id: String): androidx.work.ListenableWorker.Result =
        TestListenableWorkerBuilder<ReportRetryWorker>(context)
            .setInputData(ReportRetryWorker.input(id))
            .build()
            .doWork()

    private fun payload(id: String) = SmsPayload(
        deviceId = "device-1",
        deviceName = "Test device",
        sender = "+15551234567",
        rawContent = "body-$id",
        timestamp = 1_700_000_000_000,
        clientMessageId = id,
    )
}
