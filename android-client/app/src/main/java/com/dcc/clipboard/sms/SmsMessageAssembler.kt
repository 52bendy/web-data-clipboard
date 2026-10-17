package com.dcc.clipboard.sms

/**
 * Concatenates the PDUs of one SMS_RECEIVED broadcast.
 *
 * Android delivers all segments of a multipart SMS in a single broadcast and
 * in transmission order. Sorting by the PDU timestamp keeps the order stable
 * for the (rare) case where an OEM reorders the array; `sortedBy` is stable,
 * so segments sharing a timestamp keep their original order.
 */
object SmsMessageAssembler {

    fun assemble(segments: List<SmsSegment>): AssembledSms? {
        if (segments.isEmpty()) {
            return null
        }
        val ordered = segments.sortedBy { it.timestampMillis }
        val sender = ordered.firstOrNull { it.sender.isNotBlank() }?.sender.orEmpty()
        val body = ordered.joinToString(separator = "") { it.body }
        return AssembledSms(
            sender = sender,
            body = body,
            timestampMillis = ordered.maxOf { it.timestampMillis },
            subscriptionId = ordered.first().subscriptionId,
            segmentCount = ordered.size,
        )
    }
}
