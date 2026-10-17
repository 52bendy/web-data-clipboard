package com.dcc.collector

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import com.dcc.collector.config.StorageHelper
import com.dcc.collector.report.SmsApiClient
import com.dcc.collector.report.SmsPayload
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Minimal configuration screen (PRD §5.3): server URL, token, device name,
 * SMS permission guidance and a test-connection action. The foreground
 * service switch is delivered by REQ-202610-1265.
 */
class MainActivity : Activity() {

    private lateinit var storage: StorageHelper
    private lateinit var etServerUrl: EditText
    private lateinit var etApiToken: EditText
    private lateinit var etDeviceName: EditText
    private lateinit var cbCollectionEnabled: CheckBox
    private lateinit var tvPermissionStatus: TextView
    private val worker = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        storage = StorageHelper(this)

        etServerUrl = findViewById(R.id.etServerUrl)
        etApiToken = findViewById(R.id.etApiToken)
        etDeviceName = findViewById(R.id.etDeviceName)
        cbCollectionEnabled = findViewById(R.id.cbCollectionEnabled)
        tvPermissionStatus = findViewById(R.id.tvPermissionStatus)

        etServerUrl.setText(storage.serverUrl)
        etApiToken.setText(storage.apiToken)
        etDeviceName.setText(storage.deviceName)
        cbCollectionEnabled.isChecked = storage.collectionEnabled

        findViewById<Button>(R.id.btnSave).setOnClickListener { saveConfiguration() }
        findViewById<Button>(R.id.btnRequestPermission).setOnClickListener { requestSmsPermissions() }
        findViewById<Button>(R.id.btnTestConnection).setOnClickListener { testConnection() }
        cbCollectionEnabled.setOnCheckedChangeListener { _, checked ->
            storage.collectionEnabled = checked
        }
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_SMS_PERMISSIONS) {
            updatePermissionStatus()
        }
    }

    private fun saveConfiguration(): Boolean {
        val serverUrl = etServerUrl.text.toString()
        val token = etApiToken.text.toString()
        val deviceName = etDeviceName.text.toString()
        if (!StorageHelper.isValidServerUrl(serverUrl) || token.isBlank() || deviceName.isBlank()) {
            Toast.makeText(this, R.string.config_invalid, Toast.LENGTH_LONG).show()
            return false
        }
        storage.save(serverUrl, token, deviceName)
        Toast.makeText(this, R.string.config_saved, Toast.LENGTH_SHORT).show()
        return true
    }

    private fun requestSmsPermissions() {
        // READ_SMS is declared for parity with PRD §5.1 but is not needed to
        // receive SMS_RECEIVED; requesting it would only add a scary dialog.
        if (checkSelfPermission(Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            updatePermissionStatus()
            return
        }
        requestPermissions(SMS_PERMISSIONS, REQUEST_SMS_PERMISSIONS)
    }

    private fun updatePermissionStatus() {
        val granted = checkSelfPermission(Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED
        tvPermissionStatus.setText(
            if (granted) R.string.permission_granted else R.string.permission_missing,
        )
    }

    private fun testConnection() {
        if (!saveConfiguration()) {
            return
        }
        val payload = SmsPayload(
            deviceId = storage.deviceId,
            deviceName = storage.deviceName,
            sender = "DCC-TEST",
            rawContent = "DCC 测试连接 ${System.currentTimeMillis()}",
            timestamp = System.currentTimeMillis(),
            clientMessageId = "test-${UUID.randomUUID()}",
        )
        Toast.makeText(this, R.string.test_running, Toast.LENGTH_SHORT).show()
        worker.execute {
            val result = SmsApiClient(storage).upload(payload)
            runOnUiThread {
                val message = if (result.success) {
                    getString(R.string.test_success)
                } else {
                    getString(
                        R.string.test_failed,
                        result.detail.ifBlank { "HTTP ${result.statusCode}" },
                    )
                }
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private companion object {
        const val REQUEST_SMS_PERMISSIONS = 1001
        val SMS_PERMISSIONS = arrayOf(Manifest.permission.RECEIVE_SMS)
    }
}
