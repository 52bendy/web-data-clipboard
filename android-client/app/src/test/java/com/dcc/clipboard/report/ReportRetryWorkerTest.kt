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
import org.junit.Assert.assertFalse
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
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        server = MockWebServer()
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
        assertEquals(2_000L, work.last().initialDelayMillis)
        assertEquals(NetworkType.CONNECTED, work.last().constraints.requiredNetworkType)
        assertEquals(
            setOf(ReportScheduler.INPUT_CLIENT_MESSAGE_ID, ReportScheduler.INPUT_ATTEMPT),
            ReportRetryWorker.input(payload.clientMessageId).keyValueMap.keys,
        )
        assertEquals(0, ReportRetryWorker.input(payload.clientMessageId).getInt(ReportScheduler.INPUT_ATTEMPT, -1))
    }

    @Test
    fun `consecutive failures propagate attempt and backoff delay`() {
        val payload = payload("sequence")
        store.enqueue(payload)
        server.enqueue(MockResponse().setResponseCode(500))

        runWorker(payload.clientMessageId, attempt = 0)
        var work = pendingWork(payload.clientMessageId)
        assertScheduledAttempt(work, payload.clientMessageId, expectedAttempt = 1, expectedDelay = 2)

        server.enqueue(MockResponse().setResponseCode(500))
        val secondAttemptRequest = ReportScheduler(context).createRequest(payload.clientMessageId, 1)
        assertEquals(1, secondAttemptRequest.workSpec.input.getInt(ReportScheduler.INPUT_ATTEMPT, -1))
        assertEquals(2_000L, secondAttemptRequest.workSpec.initialDelay)
        runWorker(
            payload.clientMessageId,
            attempt = secondAttemptRequest.workSpec.input.getInt(ReportScheduler.INPUT_ATTEMPT, -1),
        )
        work = pendingWork(payload.clientMessageId)
        assertScheduledAttempt(work, payload.clientMessageId, expectedAttempt = 2, expectedDelay = 4)
        assertEquals(1, store.size())
    }

    @Test
    fun `offline failure then server recovery uploads and removes all SMS data`() {
        val payload = payload("network-recovery")
        val serverPort = server.port
        store.enqueue(payload)
        server.shutdown()

        val failed = runWorker(payload.clientMessageId, attempt = 0)

        assertTrue(failed is androidx.work.ListenableWorker.Result.Success)
        assertEquals(payload, store.get(payload.clientMessageId))
        var work = pendingWork(payload.clientMessageId)
        assertScheduledAttempt(work, payload.clientMessageId, expectedAttempt = 1, expectedDelay = 2)

        server = MockWebServer().apply { start(serverPort) }
        StorageHelper(context).saveConfig(
            ClientConfig(
                serverUrl = server.url("/").toString().trimEnd('/'),
                apiToken = "test-token",
                deviceName = "Test device",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(200))
        val retryRequest = ReportScheduler(context).createRequest(payload.clientMessageId, 1)
        assertEquals(1, retryRequest.workSpec.input.getInt(ReportScheduler.INPUT_ATTEMPT, -1))
        assertEquals(2_000L, retryRequest.workSpec.initialDelay)
        val recovered = runWorker(
            payload.clientMessageId,
            attempt = retryRequest.workSpec.input.getInt(ReportScheduler.INPUT_ATTEMPT, -1),
        )

        assertTrue(recovered is androidx.work.ListenableWorker.Result.Success)
        assertEquals(0, store.size())
        val preferences = context.getSharedPreferences("dcc_pending_reports", Context.MODE_PRIVATE)
        val serialized = preferences.all.values.joinToString()
        assertFalse(serialized.contains(payload.rawContent))
        assertFalse(serialized.contains(payload.sender))
        assertFalse(serialized.contains("raw_content"))
        assertFalse(serialized.contains("sender"))
    }

    @Test
    fun `missing payload is already complete`() {
        val result = runWorker("absent")

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
        assertEquals(0, store.size())
    }

    private fun pendingWork(id: String): androidx.work.WorkInfo =
        WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(ReportScheduler.workName(id)).get()
            .filter { !it.state.isFinished }
            .maxByOrNull { it.initialDelayMillis }!!

    private fun assertScheduledAttempt(
        work: androidx.work.WorkInfo,
        id: String,
        expectedAttempt: Int,
        expectedDelay: Long,
    ) {
        val request = ReportScheduler(context).createRequest(id, expectedAttempt)
        assertEquals(expectedAttempt, request.workSpec.input.getInt(ReportScheduler.INPUT_ATTEMPT, -1))
        assertEquals(expectedDelay * 1_000, work.initialDelayMillis)
        assertEquals(NetworkType.CONNECTED, work.constraints.requiredNetworkType)
    }

    private fun runWorker(id: String, attempt: Int = 0): androidx.work.ListenableWorker.Result =
        TestListenableWorkerBuilder<ReportRetryWorker>(context)
            .setInputData(ReportRetryWorker.input(id, attempt))
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
