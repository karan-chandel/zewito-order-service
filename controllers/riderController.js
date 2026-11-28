const mongoose = require('mongoose');
const User = require('../models/User');
const Rider = require('../models/Rider');
const Order = require('../models/Order');
const { calculateDistance, calculateDeliveryEarnings } = require('../utils/deliveryUtils');
const logisticsClient = require('../utils/logisticsClient');
const riderClient = require('../utils/riderClient');
const { uploadBufferToCloudinary } = require('../middlewares/upload');
const { recordRiderLocation, shouldPersistToDb } = require('../utils/redisTracking');
const path = require('path');
const fs = require('fs');

const isValidCoord = (lat, lng) =>
  typeof lat === 'number' &&
  typeof lng === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  !(lat === 0 && lng === 0) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;

/**
 * Resolves valid restaurant & customer coordinates across route snapshot,
 * restaurantId.coordinates, restaurantId.address.geolocation, and deliveryAddress.
 */
function computeOrderDistanceAndEarnings(order) {
  const restLat = Number(
    order?.restaurantId?.coordinates?.lat ??
      order?.restaurantId?.address?.geolocation?.latitude ??
      order?.route?.restaurantLocation?.lat
  );
  const restLng = Number(
    order?.restaurantId?.coordinates?.lng ??
      order?.restaurantId?.address?.geolocation?.longitude ??
      order?.route?.restaurantLocation?.lng
  );

  const custLat = Number(
    order?.deliveryAddress?.coordinates?.lat ??
      order?.route?.customerLocation?.lat
  );
  const custLng = Number(
    order?.deliveryAddress?.coordinates?.lng ??
      order?.route?.customerLocation?.lng
  );

  let deliveryDistance = 0;
  if (isValidCoord(restLat, restLng) && isValidCoord(custLat, custLng)) {
    deliveryDistance = calculateDistance(restLat, restLng, custLat, custLng);
  }

  const roundedDistance = Math.round(deliveryDistance * 100) / 100;
  const estimatedEarnings = calculateDeliveryEarnings(roundedDistance, order?.finalAmount);
  return { deliveryDistance: roundedDistance, estimatedEarnings };
}

// Helper to emit socket events safely
function emitSocket(io, rooms = [], event, data) {
  try {
    if (!io) return;
    rooms.forEach(room => {
      if (room) io.to(room).emit(event, data);
    });
  } catch (err) {
    console.warn(`Socket emit error [${event}]:`, err.message);
  }
}

// ✅ Get rider profile
exports.getRiderProfile = async (req, res, next) => {
  try {
    const rider = await Rider.findOne({ _id: req.user._id });
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }

    res.json({
      success: true,
      data: rider
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get rider account / KYC status
exports.getRiderStatus = async (req, res, next) => {
  try {
    const rider = await Rider.findOne({ _id: req.user._id }).lean();
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }

    res.json({
      success: true,
      data: {
        riderId: rider._id,
        isVerified: Boolean(rider.isVerified),
        verificationStatus: rider.verificationStatus || (rider.isVerified ? 'approved' : 'incomplete'),
        isProfileComplete: Boolean(rider.isProfileComplete || (rider.vehicleNo && rider.licenseNumber)),
        rejectionReason: rider.rejectionReason || null,
        isActive: rider.isActive !== false,
        isOnline: Boolean(rider.isOnline),
        isAvailable: Boolean(rider.isAvailable),
        currentOrder: rider.currentOrder || null
      }
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Complete Registration + Profile Update
exports.updateRiderProfile = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);

    if (!user) {
      if (req.files?.licensePhoto?.[0]) fs.unlinkSync(req.files.licensePhoto[0].path);
      if (req.files?.vehiclePhoto?.[0]) fs.unlinkSync(req.files.vehiclePhoto[0].path);

      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.role !== 'rider') {
      if (req.files?.licensePhoto?.[0]) fs.unlinkSync(req.files.licensePhoto[0].path);
      if (req.files?.vehiclePhoto?.[0]) fs.unlinkSync(req.files.vehiclePhoto[0].path);

      return res.status(403).json({
        success: false,
        message: 'This API is only for riders'
      });
    }

    let rider = await Rider.findById(userId);

    // CASE 1: NEW REGISTRATION (rider doesn't exist)
    if (!rider) {
      const {
        name, email, vehicleType, vehicleNo, licenseNumber,
        bankAccountNumber, bankIFSC, aadharNumber
      } = req.body;

      if (!name || !vehicleType || !vehicleNo || !licenseNumber) {
        if (req.files?.licensePhoto?.[0]) fs.unlinkSync(req.files.licensePhoto[0].path);
        if (req.files?.vehiclePhoto?.[0]) fs.unlinkSync(req.files.vehiclePhoto[0].path);

        return res.status(400).json({
          success: false,
          message: 'Name, vehicle type, vehicle number, and license number are required for registration'
        });
      }

      const userUpdate = {};
      if (name) userUpdate.name = name;
      if (email) userUpdate.email = email;

      if (Object.keys(userUpdate).length > 0) {
        await User.findByIdAndUpdate(userId, userUpdate);
      }

      const riderData = {
        _id: userId,
        phone: user.phone,
        name: name,
        email: email || user.email || null,
        role: 'rider',
        isVerified: false,
        vehicleType: vehicleType,
        vehicleNo: vehicleNo,
        licenseNumber: licenseNumber,
        bankAccountNumber: bankAccountNumber || null,
        bankIFSC: bankIFSC || null,
        aadharNumber: aadharNumber || null,
        isOnline: false,
        isAvailable: false,
        currentLocation: null,
        totalDeliveries: 0,
        completedDeliveries: 0,
        cancelledDeliveries: 0,
        earnings: { total: 0, weekly: 0, monthly: 0 },
        rating: 0,
        totalRatings: 0,
        ratings: []
      };

      if (req.files?.licensePhoto?.[0]) {
        const file = req.files.licensePhoto[0];
        if (file.buffer) {
          try {
            const uploadRes = await uploadBufferToCloudinary(file.buffer, "Zewito/riders/license");
            riderData.licensePhoto = uploadRes.secure_url;
          } catch (err) {
            console.error("License photo upload error:", err);
          }
        } else if (file.filename) {
          riderData.licensePhoto = `/uploads/riders/${file.filename}`;
        }
      }

      if (req.files?.vehiclePhoto?.[0]) {
        const file = req.files.vehiclePhoto[0];
        if (file.buffer) {
          try {
            const uploadRes = await uploadBufferToCloudinary(file.buffer, "Zewito/riders/vehicle");
            riderData.vehiclePhoto = uploadRes.secure_url;
          } catch (err) {
            console.error("Vehicle photo upload error:", err);
          }
        } else if (file.filename) {
          riderData.vehiclePhoto = `/uploads/riders/${file.filename}`;
        }
      }

      rider = await Rider.create(riderData);

      return res.status(201).json({
        success: true,
        message: 'Rider registration completed. Waiting for admin approval.',
        data: {
          riderId: rider._id,
          name: rider.name,
          phone: rider.phone,
          email: rider.email,
          vehicleType: rider.vehicleType,
          vehicleNo: rider.vehicleNo,
          licenseNumber: rider.licenseNumber,
          hasLicensePhoto: !!rider.licensePhoto,
          hasVehiclePhoto: !!rider.vehiclePhoto,
          verificationStatus: 'pending',
          isNewRegistration: true
        }
      });
    }
    // CASE 2: PROFILE UPDATE (rider already exists)
    else {
      const {
        name, email, vehicleType, vehicleNo, licenseNumber,
        bankAccountNumber, bankIFSC, aadharNumber
      } = req.body;

      const userUpdate = {};
      if (name !== undefined && name !== '') userUpdate.name = name;
      if (email !== undefined && email !== '') userUpdate.email = email;

      if (Object.keys(userUpdate).length > 0) {
        await User.findByIdAndUpdate(userId, userUpdate);
      }

      const riderUpdate = {};
      if (name !== undefined && name !== '') riderUpdate.name = name;
      if (email !== undefined && email !== '') riderUpdate.email = email;
      if (vehicleType !== undefined && vehicleType !== '') riderUpdate.vehicleType = vehicleType;
      if (vehicleNo !== undefined && vehicleNo !== '') riderUpdate.vehicleNo = vehicleNo;
      if (licenseNumber !== undefined && licenseNumber !== '') riderUpdate.licenseNumber = licenseNumber;
      if (bankAccountNumber !== undefined && bankAccountNumber !== '') riderUpdate.bankAccountNumber = bankAccountNumber;
      if (bankIFSC !== undefined && bankIFSC !== '') riderUpdate.bankIFSC = bankIFSC;
      if (aadharNumber !== undefined && aadharNumber !== '') riderUpdate.aadharNumber = aadharNumber;

      if (req.files?.licensePhoto?.[0]) {
        const file = req.files.licensePhoto[0];
        if (file.buffer) {
          try {
            const uploadRes = await uploadBufferToCloudinary(file.buffer, "Zewito/riders/license");
            riderUpdate.licensePhoto = uploadRes.secure_url;
          } catch (err) {
            console.error("License photo update upload error:", err);
          }
        } else if (file.filename) {
          riderUpdate.licensePhoto = `/uploads/riders/${file.filename}`;
        }
      }

      if (req.files?.vehiclePhoto?.[0]) {
        const file = req.files.vehiclePhoto[0];
        if (file.buffer) {
          try {
            const uploadRes = await uploadBufferToCloudinary(file.buffer, "Zewito/riders/vehicle");
            riderUpdate.vehiclePhoto = uploadRes.secure_url;
          } catch (err) {
            console.error("Vehicle photo update upload error:", err);
          }
        } else if (file.filename) {
          riderUpdate.vehiclePhoto = `/uploads/riders/${file.filename}`;
        }
      }

      if (Object.keys(riderUpdate).length === 0 && !req.files) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }

      rider = await Rider.findByIdAndUpdate(
        userId,
        { $set: riderUpdate },
        { new: true, runValidators: true }
      );

      const updatedRider = await Rider.findById(userId);

      return res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: {
          rider: {
            _id: updatedRider._id,
            name: updatedRider.name,
            phone: updatedRider.phone,
            email: updatedRider.email,
            vehicleType: updatedRider.vehicleType,
            vehicleNo: updatedRider.vehicleNo,
            licenseNumber: updatedRider.licenseNumber,
            bankAccountNumber: updatedRider.bankAccountNumber,
            bankIFSC: updatedRider.bankIFSC,
            aadharNumber: updatedRider.aadharNumber,
            licensePhoto: updatedRider.licensePhoto,
            vehiclePhoto: updatedRider.vehiclePhoto,
            isOnline: updatedRider.isOnline,
            isAvailable: updatedRider.isAvailable,
            isVerified: updatedRider.isVerified,
            totalDeliveries: updatedRider.totalDeliveries,
            completedDeliveries: updatedRider.completedDeliveries,
            earnings: updatedRider.earnings
          },
          isNewRegistration: false
        }
      });
    }
  } catch (err) {
    if (req.files?.licensePhoto?.[0]) {
      try { fs.unlinkSync(req.files.licensePhoto[0].path); } catch (e) {}
    }
    if (req.files?.vehiclePhoto?.[0]) {
      try { fs.unlinkSync(req.files.vehiclePhoto[0].path); } catch (e) {}
    }
    next(err);
  }
};

// ✅ Update Rider Availability
exports.updateRiderAvailability = async (req, res, next) => {
  try {
    const { isOnline, isAvailable } = req.body;

    const rider = await Rider.findById(req.user._id);
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }

    if (!rider.isVerified && rider.verificationStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        code: 'KYC_NOT_APPROVED',
        error: 'Your rider account is pending verification. Please contact admin.',
        verificationStatus: rider.verificationStatus || 'incomplete'
      });
    }

    const goingOfflineOrUnavailable = isOnline === false || isAvailable === false;
    if (goingOfflineOrUnavailable) {
      const activeOrder = rider.currentOrder || (await Order.findOne({
        riderId: rider._id,
        status: { $in: ['assigned_to_rider', 'picked_up', 'out_for_delivery', 'arrived_at_location'] }
      }).select('_id orderId').lean());

      if (activeOrder) {
        return res.status(409).json({
          success: false,
          code: 'ACTIVE_ORDER_IN_PROGRESS',
          error: 'Cannot go offline or mark unavailable while an active order is in progress',
          message: 'Complete your current active order before going offline',
          currentOrder: activeOrder._id || activeOrder
        });
      }
    }

    if (isOnline !== undefined) rider.isOnline = isOnline;
    if (isAvailable !== undefined) rider.isAvailable = isAvailable;
    if (isOnline === false && isAvailable === undefined) rider.isAvailable = false;

    await rider.save();

    const io = req.app.get('io');
    if (io) {
      io.to('admin_dashboard_room').emit('rider_availability_updated', {
        riderId: rider._id,
        riderName: rider.name,
        isOnline: rider.isOnline,
        isAvailable: rider.isAvailable,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: 'Availability updated successfully',
      data: {
        isOnline: rider.isOnline,
        isAvailable: rider.isAvailable
      }
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Update Rider Location
exports.updateRiderLocation = async (req, res, next) => {
  try {
    const { lat, lng, address } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required'
      });
    }

    const numericLat = parseFloat(lat);
    const numericLng = parseFloat(lng);
    const riderId = req.user._id;

    // 1. Fast Redis Geospatial index update (< 1ms)
    recordRiderLocation({
      riderId,
      lat: numericLat,
      lng: numericLng,
      address,
      riderName: req.user.name || 'Delivery Partner'
    }).catch(() => {});

    // 2. Fetch rider & order for socket broadcast
    const rider = await Rider.findById(riderId);
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }

    const effectiveAddress = address || rider.currentLocation?.address || '';

    // 3. Write-behind throttling to MongoDB (at most once per 15s)
    if (shouldPersistToDb(riderId, 15000)) {
      rider.currentLocation = {
        lat: numericLat,
        lng: numericLng,
        address: effectiveAddress,
        lastUpdated: new Date()
      };
      await rider.save().catch(err => console.warn('⚠️ [Rider DB Write-Behind]', err.message));
    }

    // 4. Emit real-time tracking events to sockets
    const io = req.app.get('io');
    if (io) {
      io.to(`rider_${rider._id}`).emit('rider_location_updated', {
        riderId: rider._id,
        location: { lat: numericLat, lng: numericLng },
        address: effectiveAddress,
        timestamp: new Date()
      });

      if (rider.currentOrder) {
        const order = await Order.findById(rider.currentOrder);
        if (order) {
          const trackingPayload = {
            orderId: order.orderId,
            riderId: rider._id,
            riderName: rider.name,
            lat: numericLat,
            lng: numericLng,
            location: { lat: numericLat, lng: numericLng },
            currentLocation: { lat: numericLat, lng: numericLng, address: effectiveAddress },
            address: effectiveAddress,
            timestamp: new Date()
          };

          io.to(`order_${order.orderId}`).emit('rider_location_changed', trackingPayload);
          if (order._id && order._id.toString() !== String(order.orderId)) {
            io.to(`order_${order._id}`).emit('rider_location_changed', trackingPayload);
          }

          // Cache order tracking in Redis as well
          recordRiderLocation({
            riderId,
            lat: numericLat,
            lng: numericLng,
            address: effectiveAddress,
            orderId: order.orderId,
            riderName: rider.name
          }).catch(() => {});
        }
      }
    }

    res.json({
      success: true,
      message: 'Location updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get Available Orders for Rider
exports.getAvailableOrders = async (req, res, next) => {
  try {
    const rider = await riderClient.getRiderById(req.user._id, req.user.phone);
    if (!rider || !rider.isOnline || !rider.isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'Rider is not available for orders',
        details: {
          riderFound: Boolean(rider),
          isOnline: Boolean(rider?.isOnline),
          isAvailable: Boolean(rider?.isAvailable),
        },
      });
    }

    const availableOrders = await Order.find({
      status: 'ready_for_pickup',
      $or: [{ riderId: { $exists: false } }, { riderId: null }]
    })
      .populate('restaurantId', 'name address coordinates')
      .populate('customerId', 'name phone')
      .limit(20);

    const ordersWithDistance = availableOrders.map(order => {
      const { deliveryDistance, estimatedEarnings } = computeOrderDistanceAndEarnings(order);

      return {
        ...order.toObject(),
        deliveryDistance,
        estimatedEarnings
      };
    });

    ordersWithDistance.sort((a, b) => a.deliveryDistance - b.deliveryDistance);

    res.json({
      success: true,
      data: ordersWithDistance
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Accept Order for Delivery
exports.acceptOrder = async (req, res, next) => {
  try {
    const rider = await riderClient.getRiderById(req.user._id, req.user.phone);
    if (!rider || !rider.isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'Rider is not available'
      });
    }

    const orderQuery = {
      $or: [
        { orderId: req.params.orderId },
        ...(mongoose.Types.ObjectId.isValid(req.params.orderId) ? [{ _id: req.params.orderId }] : [])
      ]
    };

    const existingOrder = await Order.findOne(orderQuery)
      .populate('restaurantId', 'name address coordinates')
      .populate('customerId', 'name phone');

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    if (existingOrder.status !== 'ready_for_pickup') {
      return res.status(400).json({
        success: false,
        message: 'Order is not ready for pickup'
      });
    }

    if (existingOrder.riderId) {
      return res.status(409).json({
        success: false,
        message: 'Order already assigned to another rider'
      });
    }

    const { deliveryDistance, estimatedEarnings } = computeOrderDistanceAndEarnings(existingOrder);
    const estimatedDeliveryTime = new Date(Date.now() + 30 * 60 * 1000);

    // Atomic conditional update prevents concurrent double-accept race conditions
    const order = await Order.findOneAndUpdate(
      {
        _id: existingOrder._id,
        status: 'ready_for_pickup',
        $or: [{ riderId: { $exists: false } }, { riderId: null }]
      },
      {
        $set: {
          riderId: rider._id,
          status: 'assigned_to_rider',
          'deliveryInfo.assignedAt': new Date(),
          'deliveryInfo.estimatedDeliveryTime': estimatedDeliveryTime,
          'deliveryInfo.riderEarnings': estimatedEarnings,
          'deliveryInfo.distance': deliveryDistance
        }
      },
      { new: true }
    )
      .populate('restaurantId', 'name coordinates')
      .populate('customerId', 'name phone');

    if (!order) {
      return res.status(409).json({
        success: false,
        message: 'Order already assigned to another rider'
      });
    }

    await Promise.all([
      Rider.findByIdAndUpdate(rider._id, {
        $set: { isAvailable: false, currentOrder: order._id }
      }).catch(() => {}),
      riderClient.syncRiderStats(rider._id, {
        isAvailable: false,
        currentOrder: order._id
      })
    ]);

    const io = req.app.get('io');
    if (io) {
      const rooms = [
        order.restaurantId?._id ? `restaurant_${order.restaurantId._id}` : null,
        order.customerId?._id ? `user_${order.customerId._id}` : null,
        `order_${order.orderId}`
      ].filter(Boolean);

      emitSocket(io, rooms, 'order_assigned_to_rider', {
        orderId: order.orderId,
        orderMongoId: order._id,
        rider: {
          id: rider._id,
          name: rider.name,
          phone: rider.phone,
          vehicleType: rider.vehicleType,
          vehicleNo: rider.vehicleNo
        },
        customerId: order.customerId?._id,
        restaurantId: order.restaurantId?._id,
        estimatedDeliveryTime: order.deliveryInfo.estimatedDeliveryTime,
        timestamp: new Date()
      });

      io.to('riders_room').emit('order_accepted', {
        orderId: order.orderId,
        acceptedBy: rider.name,
        timestamp: new Date()
      });
    }

    const orderWithEarnings = {
      ...order.toObject(),
      deliveryDistance: Math.round(deliveryDistance * 100) / 100,
      estimatedEarnings: estimatedEarnings
    };

    res.json({
      success: true,
      message: 'Order accepted successfully',
      data: {
        order: orderWithEarnings,
        estimatedDeliveryTime: order.deliveryInfo.estimatedDeliveryTime
      }
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get Accepted/Ongoing Orders
exports.getAcceptedOrders = async (req, res, next) => {
  try {
    const acceptedOrders = await Order.find({
      riderId: req.user._id,
      status: {
        $in: ['assigned_to_rider', 'picked_up', 'out_for_delivery']
      }
    })
      .populate('restaurantId', 'name address')
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: acceptedOrders
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Update Order Delivery Status
exports.updateOrderStatusByRider = async (req, res, next) => {
  try {
    const { note, lat, lng } = req.body;
    const status = typeof req.body.status === 'string' ? req.body.status.toLowerCase().trim() : req.body.status;
    const validStatuses = ['picked_up', 'out_for_delivery', 'arrived_at_location', 'delivered', 'failed'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const rider = await riderClient.getRiderById(req.user._id);
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }

    const orderQuery = {
      $or: [
        { orderId: req.params.orderId },
        ...(mongoose.Types.ObjectId.isValid(req.params.orderId) ? [{ _id: req.params.orderId }] : [])
      ],
      riderId: rider._id
    };
    const order = await Order.findOne(orderQuery)
      .populate('restaurantId', 'name')
      .populate('customerId', 'name');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const previousStatus = order.status;
    order.status = status;

    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({
      status,
      updatedBy: rider._id,
      note,
      timestamp: new Date(),
      ...(lat && lng && { location: { lat, lng } })
    });

    const riderSyncPayload = {};
    const localRiderUpdate = {};

    if (status === 'picked_up') {
      order.deliveryInfo = order.deliveryInfo || {};
      order.deliveryInfo.pickedUpAt = new Date();
    } else if (status === 'delivered') {
      order.deliveredAt = new Date();
      order.deliveryInfo = order.deliveryInfo || {};
      order.deliveryInfo.deliveredAt = new Date();
      order.deliveryInfo.actualDeliveryTime = new Date();

      if (['cod', 'cash_on_delivery'].includes(order.paymentMethod) && order.paymentStatus !== 'paid') {
        order.paymentStatus = 'paid';
      }

      // 🏍️ Process Delivery Partner Payout via zewito-logistics-service microservice
      const payoutResult = await logisticsClient.processOrderDeliveryPayout(order, rider);
      const earnings = payoutResult.totalPayout;

      order.deliveryInfo.riderEarnings = earnings;
      order.deliveryInfo.payoutSource = payoutResult.source;

      riderSyncPayload.isAvailable = true;
      riderSyncPayload.currentOrder = null;
      riderSyncPayload.incrementTotalDeliveries = 1;
      riderSyncPayload.incrementCompletedDeliveries = 1;
      riderSyncPayload.addEarnings = earnings;

      localRiderUpdate.$set = { isAvailable: true, currentOrder: null };
      localRiderUpdate.$inc = {
        totalDeliveries: 1,
        completedDeliveries: 1,
        'earnings.total': earnings,
        'earnings.weekly': earnings,
        'earnings.monthly': earnings
      };
    } else if (status === 'failed') {
      riderSyncPayload.isAvailable = true;
      riderSyncPayload.currentOrder = null;
      riderSyncPayload.incrementCancelledDeliveries = 1;

      localRiderUpdate.$set = { isAvailable: true, currentOrder: null };
      localRiderUpdate.$inc = { cancelledDeliveries: 1 };
    }

    const tasks = [order.save()];
    if (Object.keys(localRiderUpdate).length > 0) {
      tasks.push(Rider.findByIdAndUpdate(rider._id, localRiderUpdate).catch(() => {}));
    }
    if (Object.keys(riderSyncPayload).length > 0) {
      tasks.push(riderClient.syncRiderStats(rider._id, riderSyncPayload));
    }

    await Promise.all(tasks);

    const io = req.app.get('io');
    if (io) {
      const rooms = [
        order.customerId?._id ? `user_${order.customerId._id}` : null,
        order.restaurantId?._id ? `restaurant_${order.restaurantId._id}` : null,
        `order_${order.orderId}`
      ].filter(Boolean);

      emitSocket(io, rooms, 'order_delivery_status_updated', {
        orderId: order.orderId,
        orderMongoId: order._id,
        status,
        previousStatus,
        riderId: rider._id,
        riderName: rider.name,
        customerId: order.customerId?._id,
        restaurantId: order.restaurantId?._id,
        estimatedDeliveryMinutes: order.estimatedDeliveryMinutes ?? 30,
        orderConfirmedAt: order.orderConfirmedAt || null,
        paymentStatus: order.paymentStatus,
        note,
        timestamp: new Date()
      });

      const statusPayload = {
        _id: order._id,
        orderId: order.orderId,
        status,
        estimatedDeliveryMinutes: order.estimatedDeliveryMinutes ?? 30,
        orderConfirmedAt: order.orderConfirmedAt || null,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        riderId: rider._id,
        timestamp: new Date()
      };
      emitSocket(io, rooms, 'order_status_changed', statusPayload);
      emitSocket(io, rooms, 'order_status_update', statusPayload);

      const custPaymentId = (order.customerId?._id || order.customerId)?.toString();
      if (status === 'delivered' && ['cod', 'cash_on_delivery'].includes(order.paymentMethod) && custPaymentId) {
        io.to(`user_${custPaymentId}`).emit('payment_update', {
          orderId: order.orderId,
          paymentStatus: 'paid'
        });
      }
    }

    res.json({
      success: true,
      message: 'Order status updated successfully',
      data: {
        order,
        ...(status === 'delivered' && { earnings: order.deliveryInfo.riderEarnings })
      }
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get Current Assigned Orders
exports.getCurrentOrders = async (req, res, next) => {
  try {
    const currentOrders = await Order.find({
      riderId: req.user._id,
      status: { $in: ['assigned_to_rider', 'picked_up', 'out_for_delivery', 'arrived_at_location'] }
    })
      .populate('restaurantId', 'name address coordinates')
      .populate('customerId', 'name phone deliveryAddress')
      .sort({ 'deliveryInfo.assignedAt': -1 });

    const sanitizedCurrent = currentOrders.map((d) => {
      const obj = d.toObject();
      if (!obj.restaurantId) {
        obj.restaurantId = {
          _id: d.get ? d.get("restaurantId") : d.restaurantId,
          name: obj.route?.restaurantLocation?.address || "Restaurant",
          address: { addressLine1: obj.route?.restaurantLocation?.address || "" },
          coordinates: obj.route?.restaurantLocation ? { lat: obj.route.restaurantLocation.lat, lng: obj.route.restaurantLocation.lng } : null,
        };
      }
      if (!obj.customerId) {
        obj.customerId = {
          _id: d.get ? d.get("customerId") : d.customerId,
          name: "Customer",
          phone: "",
        };
      }
      return obj;
    });

    res.json({
      success: true,
      data: sanitizedCurrent
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get Rider Earnings & Analytics
exports.getRiderEarnings = async (req, res, next) => {
  try {
    const rider = await Rider.findById(req.user._id);
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }

    const recentDeliveries = await Order.find({
      riderId: rider._id,
      status: 'delivered'
    })
      .sort({ deliveredAt: -1 })
      .limit(50)
      .select('deliveryInfo.riderEarnings deliveredAt');

    const analytics = {
      totalEarnings: rider.earnings?.total || 0,
      weeklyEarnings: rider.earnings?.weekly || 0,
      monthlyEarnings: rider.earnings?.monthly || 0,
      totalDeliveries: rider.totalDeliveries || 0,
      completedDeliveries: rider.completedDeliveries || 0,
      cancellationRate: ((rider.cancelledDeliveries || 0) / (rider.totalDeliveries || 1)) * 100,
      averageRating: rider.averageRating || 0,
      recentDeliveries: recentDeliveries.map(d => ({
        earnings: d.deliveryInfo?.riderEarnings || 0,
        deliveredAt: d.deliveredAt
      }))
    };

    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get Rider History
exports.getRiderHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (page - 1) * limit;

    const filter = { riderId: req.user._id };
    if (status) filter.status = status;

    const deliveries = await Order.find(filter)
      .populate('restaurantId', 'name address')
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Order.countDocuments(filter);

    const sanitizedDeliveries = deliveries.map((d) => {
      const obj = d.toObject();
      if (!obj.restaurantId) {
        obj.restaurantId = {
          _id: d.get ? d.get("restaurantId") : d.restaurantId,
          name: obj.route?.restaurantLocation?.address || "Restaurant",
          address: { addressLine1: obj.route?.restaurantLocation?.address || "" },
        };
      }
      if (!obj.customerId) {
        obj.customerId = {
          _id: d.get ? d.get("customerId") : d.customerId,
          name: "Customer",
          phone: "",
        };
      }
      return obj;
    });

    res.json({
      success: true,
      data: sanitizedDeliveries,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalDeliveries: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    next(error);
  }
};
