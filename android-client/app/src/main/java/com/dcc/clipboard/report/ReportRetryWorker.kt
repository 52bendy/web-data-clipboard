package com.dcc.clipboard.report

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.dcc.clipboard.data.StorageHelper

class ReportRetryWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {
    override fun doWork(): Result {
        val clientMessageId = inputData.getString(ReportScheduler.INPUT_CLIENT_MESSAGE_ID)
            ?: return Result.failure()
        val store = PendingReportStore(applicationContext)
        val payload = store.get(clientMessageId) ?: return Result.success()
        val result = SmsApiClient(StorageHelper(applicationContext)).execute(payload)
        if (result.success) {
            store.remove(clientMessageId)
            return Result.success()
        }
        ReportScheduler(applicationContext).schedule(clientMessageId, runAttemptCount + 1)
        return Result.success()
    }

    companion object {
        fun input(clientMessageId: String) =
            androidx.work.workDataOf(ReportScheduler.INPUT_CLIENT_MESSAGE_ID to clientMessageId)
    }
}
