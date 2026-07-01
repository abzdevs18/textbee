// TextBee SMS Diagnostic Check
// Run this in your MongoDB to check the latest SMS and their statuses

// Check latest SMS messages
print("=== Latest 10 SMS Messages ===");
db.sms.find({}, {
  phoneNumber: 1,
  message: 1,
  status: 1,
  errorCode: 1,
  errorMessage: 1,
  createdAt: 1,
  dispatchedAt: 1,
  failedAt: 1
}).sort({createdAt: -1}).limit(10).forEach(function(sms) {
  print("\n---");
  print("ID: " + sms._id);
  print("Phone: " + sms.phoneNumber);
  print("Status: " + sms.status);
  print("Message: " + (sms.message || "").substring(0, 50) + "...");
  print("Created: " + sms.createdAt);
  if (sms.dispatchedAt) print("Dispatched: " + sms.dispatchedAt);
  if (sms.failedAt) print("Failed: " + sms.failedAt);
  if (sms.errorCode) print("Error Code: " + sms.errorCode);
  if (sms.errorMessage) print("Error Message: " + sms.errorMessage);
});

// Check devices and their FCM tokens
print("\n\n=== Registered Devices ===");
db.devices.find({}, {
  name: 1,
  fcmToken: 1,
  isActive: 1,
  batteryPercentage: 1,
  lastSeenAt: 1,
  sentSMSCount: 1
}).forEach(function(device) {
  print("\n---");
  print("ID: " + device._id);
  print("Name: " + device.name);
  print("Active: " + device.isActive);
  print("FCM Token: " + (device.fcmToken ? device.fcmToken.substring(0, 20) + "..." : "NONE"));
  print("Last Seen: " + device.lastSeenAt);
  print("SMS Sent: " + (device.sentSMSCount || 0));
  print("Battery: " + (device.batteryPercentage || "unknown") + "%");
});

// Check SMS batches
print("\n\n=== Latest SMS Batches ===");
db.smsbatches.find({}, {
  status: 1,
  recipientCount: 1,
  successCount: 1,
  failureCount: 1,
  createdAt: 1
}).sort({createdAt: -1}).limit(5).forEach(function(batch) {
  print("\n---");
  print("Batch ID: " + batch._id);
  print("Status: " + batch.status);
  print("Recipients: " + batch.recipientCount);
  print("Success: " + batch.successCount);
  print("Failures: " + batch.failureCount);
  print("Created: " + batch.createdAt);
});
