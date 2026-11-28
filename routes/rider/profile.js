const express = require('express');
const router = express.Router();
const riderController = require('../../controllers/riderController');
const { auth, requireRole } = require('../../middlewares/auth');
const path = require('path');
const fs = require('fs');
const { upload, handleUploadErrors } = require('../../middlewares/upload');
const riderUpload = upload;

router.use(auth);
router.use(requireRole(['rider', 'admin', 'super_admin']));

router.get('/', riderController.getRiderProfile);
router.get('/profile', riderController.getRiderProfile);
router.get('/status', riderController.getRiderStatus);

router.put('/', riderUpload.fields([{ name: 'licensePhoto', maxCount: 1 }, { name: 'vehiclePhoto', maxCount: 1 }]), handleUploadErrors, riderController.updateRiderProfile);
router.put('/profile', riderUpload.fields([{ name: 'licensePhoto', maxCount: 1 }, { name: 'vehiclePhoto', maxCount: 1 }]), handleUploadErrors, riderController.updateRiderProfile);

router.route('/availability')
  .put(riderController.updateRiderAvailability)
  .patch(riderController.updateRiderAvailability);
router.get('/earnings', riderController.getRiderEarnings);
router.get('/history', riderController.getRiderHistory);

module.exports = router;
