package com.dcc.clipboard.report

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object RetryBackoff {
    const val MAX_DELAY_SECONDS = 300L

    fun delaySeconds(attempt: Int): Long {
        require(attempt >= 0)
        val shift = attempt.coerceAtMost(30)
        return (1L shl shift).coerceAtMost(MAX_DELAY_SECONDS)
    }
}

class ReportScheduler(context: Context) {
    private val workManager = WorkManager.getInstance(context.applicationContext)

    fun schedule(clientMessageId: String, attempt: Int = 0) {
        val request = createRequest(clientMessageId, attempt)
        workManager.enqueueUniqueWork(
            workName(clientMessageId),
            if (attempt == 0) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
    }

    internal fun createRequest(clientMessageId: String, attempt: Int = 0) =
        OneTimeWorkRequestBuilder<ReportRetryWorker>()
            .setConstraints(CONSTRAINTS)
            .setInitialDelay(delaySeconds(attempt), TimeUnit.SECONDS)
            .setInputData(workInput(clientMessageId, attempt))
            .build()

    internal fun workInput(clientMessageId: String, attempt: Int) =
        ReportRetryWorker.input(clientMessageId, attempt)

    internal fun delaySeconds(attempt: Int): Long = RetryBackoff.delaySeconds(attempt)

    fun schedulePending(context: Context) {
        PendingReportStore(context).snapshot().forEach { payload ->
            val name = workName(payload.clientMessageId)
            val active = workManager.getWorkInfosForUniqueWork(name).get().any { !it.state.isFinished }
            if (!active) schedule(payload.clientMessageId)
        }
    }

    companion object {
        const val INPUT_CLIENT_MESSAGE_ID = "client_message_id"
        const val INPUT_ATTEMPT = "attempt"
        val CONSTRAINTS = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        fun workName(clientMessageId: String): String = "dcc_report_$clientMessageId"
    }
}
