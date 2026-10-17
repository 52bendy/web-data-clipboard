package com.dcc.clipboard.sms

/**
 * One PDU decoded by [SmsMessageParser]. Kept free of Android types so the
 * multipart assembly rules can be unit tested on the JVM.
 */
data class SmsSegment(
    val sender: String,
    val body: String,
    val timestampMillis: Long,
    val subscriptionId: Int,
)

/** One logical SMS after concatenating all of its PDUs. */
data class AssembledSms(
    val sender: String,
    val body: String,
    val timestampMillis: Long,
    val subscriptionId: Int,
    val segmentCount: Int,
)
