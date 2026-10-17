package com.dcc.clipboard.sms

/**
 * Masks a sender before it reaches logcat (PRD §8.2). Short service numbers
 * are left untouched because they do not contain a personal phone number.
 */
object SenderMask {

    fun mask(sender: String): String {
        val value = sender.trim()
        if (value.isEmpty()) {
            return ""
        }
        val prefix = if (value.startsWith("+86")) "+86" else ""
        val digits = if (prefix.isEmpty()) value else value.substring(prefix.length)
        if (digits.length < 8) {
            return value
        }
        return prefix + digits.take(3) + "****" + digits.takeLast(4)
    }
}
