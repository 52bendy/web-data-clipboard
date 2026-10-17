package com.dcc.clipboard.network

import com.dcc.clipboard.data.ClientConfig
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.net.ServerSocket
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TestConnectionClientTest {
    @Test
    fun `posts the simulated report with the token header and parses success`() {
        StubHttpServer(
            status = 200,
            responseBody = """
                {"code":200,"message":"Data collected successfully","data":{
                "collection_id":"col_1728950400000123456","extracted_code":"123456",
                "clipboard_updated":true}}
            """.trimIndent(),
        ).use { server ->
            val client = TestConnectionClient(connectTimeoutMs = 10_000, readTimeoutMs = 10_000)
            val result = client.test(
                config = ClientConfig(
                    serverUrl = "http://127.0.0.1:${server.port}",
                    apiToken = "test-token",
                    deviceName = "Test Device",
                    serviceEnabled = true,
                ),
                deviceId = "android_test_device",
                timestamp = 1_728_950_400_000L,
            )

            assertTrue(result is TestConnectionResult.Success)
            result as TestConnectionResult.Success
            assertEquals("col_1728950400000123456", result.collectionId)
            assertEquals("123456", result.extractedCode)

            assertEquals("POST /api/v1/collect HTTP/1.1", server.requestLine)
            assertEquals("test-token", server.requestHeaders["x-dcc-token"])
            val payload = JSONObject(server.requestBody)
            assertEquals("android_test_device", payload.getString("device_id"))
            assertEquals("Test Device", payload.getString("device_name"))
            assertEquals("android", payload.getString("platform"))
            assertEquals(1_728_950_400_000L, payload.getLong("timestamp"))
        }
    }

    @Test
    fun `reports the backend error envelope for a wrong token`() {
        StubHttpServer(
            status = 401,
            responseBody = """{"code":401,"message":"Unauthorized","data":null}""",
        ).use { server ->
            val client = TestConnectionClient(connectTimeoutMs = 10_000, readTimeoutMs = 10_000)
            val result = client.test(
                config = ClientConfig(
                    serverUrl = "http://127.0.0.1:${server.port}",
                    apiToken = "wrong-token",
                    deviceName = "Test Device",
                ),
                deviceId = "android_test_device",
            )

            assertTrue(result is TestConnectionResult.Rejected)
            result as TestConnectionResult.Rejected
            assertEquals(401, result.httpStatus)
            assertEquals("Unauthorized", result.serverMessage)
        }
    }

    @Test
    fun `reports a network error when the server is unreachable`() {
        val port = ServerSocket(0).use { it.localPort }
        val client = TestConnectionClient(connectTimeoutMs = 500, readTimeoutMs = 500)

        val result = client.test(
            config = ClientConfig(
                serverUrl = "http://127.0.0.1:$port",
                apiToken = "token",
                deviceName = "Test Device",
            ),
            deviceId = "android_test_device",
        )

        assertTrue(result is TestConnectionResult.NetworkError)
    }

    private class StubHttpServer(
        private val status: Int,
        private val responseBody: String,
    ) : Closeable {
        private val serverSocket = ServerSocket(0)
        val port: Int = serverSocket.localPort

        @Volatile
        var requestLine: String = ""

        @Volatile
        var requestHeaders: Map<String, String> = emptyMap()

        @Volatile
        var requestBody: String = ""

        private val worker = thread(start = true, isDaemon = true) { serve() }

        private fun serve() {
            try {
                serverSocket.accept().use { socket ->
                    val input = socket.getInputStream()
                    val headerBytes = ByteArrayOutputStream()
                    var tail = 0
                    while (true) {
                        val byte = input.read()
                        if (byte == -1) return
                        headerBytes.write(byte)
                        tail = (tail shl 8) or byte
                        if (tail == 0x0D0A0D0A) break
                    }

                    val lines = headerBytes.toString("ISO-8859-1").split("\r\n")
                    requestLine = lines.firstOrNull().orEmpty()
                    requestHeaders = lines.drop(1)
                        .filter { it.contains(":") }
                        .associate { line ->
                            line.substringBefore(":").trim().lowercase() to
                                line.substringAfter(":").trim()
                        }

                    val contentLength = requestHeaders["content-length"]?.toIntOrNull() ?: 0
                    val bodyBytes = ByteArray(contentLength)
                    var read = 0
                    while (read < contentLength) {
                        val count = input.read(bodyBytes, read, contentLength - read)
                        if (count == -1) break
                        read += count
                    }
                    requestBody = String(bodyBytes, 0, read, Charsets.UTF_8)

                    val responseBytes = responseBody.toByteArray(Charsets.UTF_8)
                    val header = buildString {
                        append("HTTP/1.1 $status Test\r\n")
                        append("Content-Type: application/json; charset=utf-8\r\n")
                        append("Content-Length: ${responseBytes.size}\r\n")
                        append("Connection: close\r\n")
                        append("\r\n")
                    }
                    socket.getOutputStream().apply {
                        write(header.toByteArray(Charsets.ISO_8859_1))
                        write(responseBytes)
                        flush()
                    }
                }
            } catch (exception: IOException) {
                // Closing the stub during teardown is expected.
            }
        }

        override fun close() {
            serverSocket.close()
            worker.join(1_000)
        }
    }
}
