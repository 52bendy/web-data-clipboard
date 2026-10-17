package com.dcc.clipboard.network

sealed interface TestConnectionResult {
    data class Success(
        val collectionId: String?,
        val extractedCode: String?,
        val clipboardUpdated: Boolean,
    ) : TestConnectionResult

    data class Rejected(
        val httpStatus: Int,
        val serverMessage: String?,
    ) : TestConnectionResult

    data class NetworkError(
        val detail: String?,
    ) : TestConnectionResult
}
