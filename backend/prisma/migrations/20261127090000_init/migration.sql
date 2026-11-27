-- CreateEnum
CREATE TYPE "BankPaymentStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'HELD', 'REVERSED', 'PENDING_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "BankPaymentSource" AS ENUM ('WEBHOOK', 'MANUAL', 'STATEMENT');

-- CreateEnum
CREATE TYPE "FleetPartnerStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "FleetPartnerRole" AS ENUM ('OWNER', 'ADMIN', 'FLEET_MANAGER', 'OPERATIONS', 'FINANCE', 'VIEWER');

-- CreateEnum
CREATE TYPE "FleetVehicleStatus" AS ENUM ('PENDING', 'ACTIVE', 'IN_SERVICE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "FleetAssignmentStatus" AS ENUM ('ACTIVE', 'ENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FleetTripStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "BankPartnerStatus" AS ENUM ('PROSPECT', 'DUE_DILIGENCE', 'CONTRACT_PENDING', 'ACTIVE', 'PAUSED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "BankCampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BankOfferType" AS ENUM ('DISCOUNT', 'CASHBACK', 'SPONSORED_RIDE', 'SPONSORED_DELIVERY', 'DEFERRED_PAYMENT', 'CREDIT', 'ACCOUNT_OPENING');

-- CreateEnum
CREATE TYPE "BankEligibilityType" AS ENUM ('PUBLIC', 'EXISTING_BANK_CUSTOMERS', 'NEW_BANK_CUSTOMERS', 'INVITATION_ONLY', 'BANK_APPROVAL_REQUIRED');

-- CreateEnum
CREATE TYPE "BankReferralStatus" AS ENUM ('CLICKED', 'APPLICATION_STARTED', 'SUBMITTED', 'VERIFIED', 'DECLINED', 'EXPIRED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "BankRedemptionStatus" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BankSettlementStatus" AS ENUM ('PENDING', 'RECONCILING', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'DRIVER', 'DELIVERY_PARTNER', 'ADMIN', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('RIDE', 'DELIVERY');

-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'WALLET', 'MOBILE_MONEY', 'CORPORATE');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('BIKE', 'CAR', 'MOTORCYCLE', 'VAN', 'TRICYCLE');

-- CreateEnum
CREATE TYPE "WalletTxType" AS ENUM ('CREDIT', 'DEBIT', 'WITHDRAWAL', 'REFUND');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RidePayer" AS ENUM ('SELF', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "WeekendPolicy" AS ENUM ('APPROVAL_REQUIRED', 'OPEN_SATURDAY', 'OPEN_WEEKEND', 'CLOSED');

-- CreateEnum
CREATE TYPE "WeekendRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CorporateTripStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripAuditStatus" AS ENUM ('UNREVIEWED', 'VERIFIED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "EarnerPayoutStatus" AS ENUM ('ACCRUED', 'PAID');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "OrgPayoutStatus" AS ENUM ('PENDING', 'PAID');

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'DELISTED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ORG_ADMIN', 'HR', 'MANAGER', 'FINANCE', 'STAFF');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('PREPAID', 'POSTPAID', 'HYBRID');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DirectoryStatus" AS ENUM ('ACTIVE', 'EXITED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'USED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrgWalletTxType" AS ENUM ('TOPUP', 'TRIP_CHARGE', 'REFUND', 'ADJUSTMENT', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "DemoRequestStatus" AS ENUM ('NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "MoneyActionKind" AS ENUM ('ORG_WALLET_CREDIT', 'ORG_WALLET_ADJUST', 'INVOICE_RECEIPT', 'BANK_CREDIT_REVERSAL');

-- CreateEnum
CREATE TYPE "MoneyActionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProviderEnvironment" AS ENUM ('SANDBOX', 'LIVE');

-- CreateEnum
CREATE TYPE "ProviderOnboardingStatus" AS ENUM ('PLANNED', 'AWAITING_ONBOARDING', 'SANDBOX_ACCESS', 'CERTIFICATION', 'PRODUCTION_APPROVED');

-- CreateEnum
CREATE TYPE "PaymentExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password" TEXT NOT NULL,
    "authProvider" TEXT NOT NULL DEFAULT 'PASSWORD',
    "googleId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "profileImage" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "suspendedBy" TEXT,
    "suspensionReason" TEXT,
    "passwordResetToken" TEXT,
    "passwordResetExpires" TIMESTAMP(3),
    "emailVerifyToken" TEXT,
    "emailVerifyExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminDepartment" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "locale" TEXT,
    "supportCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supportLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorMethod" TEXT,
    "passwordChangedAt" TIMESTAMPTZ(6),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretEnc" TEXT,
    "mfaBackupHashes" TEXT[],
    "mfaLastStep" INTEGER,
    "mfaEnrolledAt" TIMESTAMPTZ(6),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMPTZ(6),
    "sessionsRevokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpVerification" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tempToken" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverProfile" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "licenseClass" TEXT,
    "licenseExpiresAt" DATE,
    "licenseVerificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "licenseVerifiedAt" TIMESTAMP(3),
    "licenseVerifiedById" TEXT,
    "licenseRejectedReason" TEXT,
    "vehicleType" "VehicleType" NOT NULL,
    "vehicleMake" TEXT NOT NULL,
    "vehicleModel" TEXT NOT NULL,
    "vehicleYear" INTEGER NOT NULL,
    "vehicleColor" TEXT NOT NULL,
    "vehiclePlate" TEXT NOT NULL,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "currentLat" DOUBLE PRECISION,
    "currentLng" DOUBLE PRECISION,
    "locationConsentAt" TIMESTAMP(3),
    "locationConsentVersion" TEXT,
    "locationConsentRevokedAt" TIMESTAMP(3),
    "lastLocationAt" TIMESTAMP(3),
    "locationAccuracy" DOUBLE PRECISION,
    "locationHeading" DOUBLE PRECISION,
    "totalRides" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preferredFloorPrice" DECIMAL(14,2),
    "insurance_url" TEXT,
    "license_image_url" TEXT,
    "vehicle_reg_url" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "documentsUploadedAt" TIMESTAMP(3),
    "isRejected" BOOLEAN NOT NULL DEFAULT false,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "floorMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "applicant_photo_url" TEXT,
    "govt_id_url" TEXT,
    "proof_of_address_url" TEXT,
    "road_worthiness_url" TEXT,
    "vehicle_inspection_url" TEXT,
    "hackney_cert_url" TEXT,
    "vehicle_photo_exterior_url" TEXT,
    "vehicle_photo_interior_url" TEXT,
    "rider_card_url" TEXT,
    "helmet_photo_url" TEXT,
    "dispatch_permit_url" TEXT,
    "guarantor_letter_url" TEXT,
    "guarantor_id_url" TEXT,
    "number_of_seats" INTEGER,
    "vehicle_sub_type" TEXT,
    "payload_capacity_kg" DOUBLE PRECISION,

    CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryPartnerProfile" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "vehiclePlate" TEXT,
    "idImageUrl" TEXT,
    "vehicleImageUrl" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "currentLat" DOUBLE PRECISION,
    "currentLng" DOUBLE PRECISION,
    "locationConsentAt" TIMESTAMP(3),
    "locationConsentVersion" TEXT,
    "locationConsentRevokedAt" TIMESTAMP(3),
    "lastLocationAt" TIMESTAMP(3),
    "locationAccuracy" DOUBLE PRECISION,
    "locationHeading" DOUBLE PRECISION,
    "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preferredFloorPrice" DECIMAL(14,2),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "documentsUploadedAt" TIMESTAMP(3),
    "isRejected" BOOLEAN NOT NULL DEFAULT false,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "floorMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "applicant_photo_url" TEXT,
    "govt_id_url" TEXT,
    "proof_of_address_url" TEXT,
    "insurance_url" TEXT,
    "road_worthiness_url" TEXT,
    "vehicle_photo_exterior_url" TEXT,
    "vehicle_photo_interior_url" TEXT,
    "dispatch_permit_url" TEXT,
    "guarantor_letter_url" TEXT,
    "guarantor_id_url" TEXT,
    "rider_card_url" TEXT,
    "helmet_photo_url" TEXT,
    "operator_permit_url" TEXT,
    "number_of_seats" INTEGER,
    "vehicle_sub_type" TEXT,

    CONSTRAINT "DeliveryPartnerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ride" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "customerId" TEXT NOT NULL,
    "driverId" TEXT,
    "pickupAddress" TEXT NOT NULL,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "pickupSource" TEXT,
    "pickupAccuracyM" DOUBLE PRECISION,
    "pickupCapturedAt" TIMESTAMP(3),
    "dropoffAddress" TEXT NOT NULL,
    "dropoffLat" DOUBLE PRECISION NOT NULL,
    "dropoffLng" DOUBLE PRECISION NOT NULL,
    "status" "RideStatus" NOT NULL DEFAULT 'REQUESTED',
    "distance" DOUBLE PRECISION,
    "duration" INTEGER,
    "estimatedFare" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "actualFare" DECIMAL(14,2),
    "promoCode" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'CASH',
    "cancellationReason" TEXT,
    "isCorporate" BOOLEAN NOT NULL DEFAULT false,
    "payerType" "RidePayer" NOT NULL DEFAULT 'SELF',
    "companyId" TEXT,

    CONSTRAINT "Ride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "customerId" TEXT NOT NULL,
    "partnerId" TEXT,
    "pickupAddress" TEXT NOT NULL,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "pickupSource" TEXT,
    "pickupAccuracyM" DOUBLE PRECISION,
    "pickupCapturedAt" TIMESTAMP(3),
    "pickupContact" TEXT NOT NULL,
    "dropoffAddress" TEXT NOT NULL,
    "dropoffLat" DOUBLE PRECISION NOT NULL,
    "dropoffLng" DOUBLE PRECISION NOT NULL,
    "dropoffContact" TEXT NOT NULL,
    "packageDescription" TEXT NOT NULL,
    "packageWeight" DOUBLE PRECISION,
    "packageValue" DECIMAL(14,2),
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "distance" DOUBLE PRECISION,
    "estimatedFee" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "actualFee" DECIMAL(14,2),
    "deliveryImageUrl" TEXT,
    "recipientName" TEXT,
    "recipientEmail" TEXT,
    "recipientSignature" TEXT,
    "promoCode" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'CASH',
    "cancellationReason" TEXT,
    "inTransitAt" TIMESTAMPTZ(6),
    "podCodeHash" TEXT,
    "podCodeNonce" TEXT,
    "podCodeVersion" INTEGER NOT NULL DEFAULT 1,
    "podCodeExpiresAt" TIMESTAMPTZ(6),
    "podCodeRotatedAt" TIMESTAMPTZ(6),
    "podNotifyReservedAt" TIMESTAMPTZ(6),
    "podCodeAttempts" INTEGER NOT NULL DEFAULT 0,
    "podVerifiedAt" TIMESTAMPTZ(6),
    "podMethod" TEXT,
    "podPhotoUrl" TEXT,
    "failedAt" TIMESTAMPTZ(6),
    "failedReason" TEXT,
    "returnStatus" TEXT,
    "returnedAt" TIMESTAMPTZ(6),
    "isCorporate" BOOLEAN NOT NULL DEFAULT false,
    "payerType" "RidePayer" NOT NULL DEFAULT 'SELF',
    "companyId" TEXT,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "receiptUrl" TEXT,
    "platformFee" DECIMAL(14,2),
    "driverEarnings" DECIMAL(14,2),
    "refundAmount" DECIMAL(14,2),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT,
    "providerRef" TEXT,
    "idempotencyKey" TEXT,
    "providerStatus" TEXT,
    "verifiedAmount" DECIMAL(14,2),
    "verifiedCurrency" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rating" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "walletId" TEXT NOT NULL,
    "type" "WalletTxType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "reference" TEXT,
    "provider" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "reference" TEXT,
    "recipientCode" TEXT,
    "transferCode" TEXT,
    "transferError" TEXT,
    "processedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bankName" TEXT,
    "payoutMethod" TEXT DEFAULT 'NG_BANK_TRANSFER',
    "payoutDetails" JSONB,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "reference" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminProfile" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "department" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "loginCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencySymbol" TEXT NOT NULL,
    "defaultLocale" TEXT NOT NULL,
    "phoneDialCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "paymentProviders" JSONB NOT NULL,
    "payoutMethod" TEXT NOT NULL DEFAULT 'NG_BANK_TRANSFER',
    "creditMethods" JSONB,
    "payoutMethods" JSONB,
    "providerConfig" JSONB,
    "languageCode" TEXT,
    "mapCenterLat" DOUBLE PRECISION,
    "mapCenterLng" DOUBLE PRECISION,
    "mapCenterCity" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountrySetting" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "countryCode" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CountrySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" TEXT NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "maxUses" INTEGER,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "maxUsesPerUser" INTEGER NOT NULL DEFAULT 1,
    "minPurchaseAmount" DECIMAL(14,2),
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "applicableFor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedTo" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketReply" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppFeedback" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "category" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionLedger" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "earnerUserId" TEXT NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "bookingFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commissionRate" DOUBLE PRECISION NOT NULL,
    "commissionAmount" DECIMAL(14,2) NOT NULL,
    "earnerAmount" DECIMAL(14,2) NOT NULL,
    "surgeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "name" TEXT NOT NULL,
    "rcNumber" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "orgCode" TEXT NOT NULL,
    "payReference" TEXT,
    "status" "CompanyStatus" NOT NULL DEFAULT 'PENDING',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedById" TEXT,
    "verificationNotes" TEXT,
    "billingMode" "BillingMode" NOT NULL DEFAULT 'PREPAID',
    "creditLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "creditTermsSignedAt" TIMESTAMPTZ(6),
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 14,
    "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.18,
    "subscriptionFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "billingEmail" TEXT,
    "walletBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lowBalanceThreshold" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "weekendPolicy" "WeekendPolicy" NOT NULL DEFAULT 'APPROVAL_REQUIRED',
    "requireTripPurpose" BOOLEAN NOT NULL DEFAULT true,
    "allowDeliveries" BOOLEAN NOT NULL DEFAULT true,
    "maxTripAmount" DECIMAL(14,2),
    "approvalThreshold" DECIMAL(14,2),
    "slug" TEXT,
    "customDomain" TEXT,
    "brandName" TEXT,
    "brandColor" TEXT,
    "brandAccent" TEXT,
    "logoUrl" TEXT,
    "tagline" TEXT,
    "supportEmail" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgWalletTx" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "type" "OrgWalletTxType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "tripId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgWalletTx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "costCenter" TEXT NOT NULL,
    "monthlyBudget" DECIMAL(14,2),
    "maxTripAmount" DECIMAL(14,2),
    "approvalThreshold" DECIMAL(14,2),
    "headEmployeeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffDirectoryEntry" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "staffNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "departmentId" TEXT,
    "jobTitle" TEXT,
    "supervisorStaffNumber" TEXT,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "exitedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffDirectoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEmployee" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'STAFF',
    "staffNumber" TEXT,
    "claimedDepartment" TEXT,
    "departmentId" TEXT,
    "supervisorId" TEXT,
    "jobTitle" TEXT,
    "directoryEntryId" TEXT,
    "directoryMatch" TEXT,
    "monthlyLimit" DECIMAL(14,2) NOT NULL DEFAULT 30000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "restrictToBusinessHours" BOOLEAN NOT NULL DEFAULT false,
    "requireTripPurpose" BOOLEAN NOT NULL DEFAULT false,
    "inviteStatus" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "invitedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMPTZ(6),
    "joinSource" TEXT NOT NULL DEFAULT 'STAFF_REQUEST',
    "requestedAt" TIMESTAMPTZ(6),
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "exitedAt" TIMESTAMPTZ(6),
    "exitReason" TEXT,
    "delistedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeekendRideRequest" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requestedDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "WeekendRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeekendRideRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "departmentId" TEXT,
    "approverEmployeeId" TEXT,
    "serviceType" TEXT NOT NULL DEFAULT 'RIDE',
    "pickupAddress" TEXT NOT NULL,
    "dropoffAddress" TEXT NOT NULL,
    "estimatedFare" DECIMAL(14,2) NOT NULL,
    "distanceKm" DOUBLE PRECISION,
    "purpose" TEXT,
    "purposeCategory" TEXT,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorporateTrip" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "departmentId" TEXT,
    "costCenter" TEXT,
    "supervisorEmployeeId" TEXT,
    "serviceType" TEXT NOT NULL DEFAULT 'RIDE',
    "status" "CorporateTripStatus" NOT NULL DEFAULT 'REQUESTED',
    "purposeCategory" TEXT,
    "purpose" TEXT,
    "fare" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "distanceKm" DOUBLE PRECISION,
    "commissionAmount" DECIMAL(14,2) NOT NULL,
    "driverEarnings" DECIMAL(14,2),
    "earnerUserId" TEXT,
    "walletPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "creditAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "driverPaidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "approvalRequestId" TEXT,
    "weekendTrip" BOOLEAN NOT NULL DEFAULT false,
    "weekendRequestId" TEXT,
    "tripAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "auditStatus" "TripAuditStatus" NOT NULL DEFAULT 'UNREVIEWED',
    "auditNote" TEXT,
    "auditedAt" TIMESTAMPTZ(6),
    "auditedById" TEXT,
    "billedAt" TIMESTAMPTZ(6),
    "invoiceId" TEXT,
    "payoutStatus" "EarnerPayoutStatus" NOT NULL DEFAULT 'ACCRUED',
    "orgPayoutId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorporateTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyInvoice" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "companyId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "paymentReference" TEXT,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "tripCount" INTEGER NOT NULL DEFAULT 0,
    "totalDistanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tripsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subscriptionAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platformFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "driverPayable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMPTZ(6) NOT NULL,
    "paidAt" TIMESTAMPTZ(6),
    "notes" TEXT,
    "driversSettledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "note" TEXT,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgPayout" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "tripCount" INTEGER NOT NULL DEFAULT 0,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platformFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "OrgPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "walletReference" TEXT,
    "paidAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetPartner" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "rcNumber" TEXT,
    "taxId" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "ownerUserId" TEXT NOT NULL,
    "status" "FleetPartnerStatus" NOT NULL DEFAULT 'PENDING',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedById" TEXT,
    "verificationNotes" TEXT,
    "commissionRate" DECIMAL(7,6) NOT NULL DEFAULT 0.10,
    "settlementTermsDays" INTEGER NOT NULL DEFAULT 7,
    "payoutAccountName" TEXT,
    "payoutBankCode" TEXT,
    "payoutAccountNumber" TEXT,
    "payoutCurrency" TEXT NOT NULL DEFAULT 'NGN',
    "supportEmail" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FleetPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetPartnerUser" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "FleetPartnerRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "invitedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetPartnerUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetInvitation" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "FleetPartnerRole" NOT NULL DEFAULT 'VIEWER',
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetShift" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetVehicle" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "subType" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelYear" INTEGER,
    "colour" TEXT,
    "registrationNumber" TEXT NOT NULL,
    "seatingCapacity" INTEGER,
    "payloadCapacityKg" DECIMAL(10,2),
    "status" "FleetVehicleStatus" NOT NULL DEFAULT 'PENDING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "insuranceExpiresAt" DATE,
    "roadworthyExpiresAt" DATE,
    "permitExpiresAt" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FleetVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetDriverAssignment" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "status" "FleetAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetDriverAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetTrip" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "serviceType" "ServiceType" NOT NULL,
    "status" "FleetTripStatus" NOT NULL DEFAULT 'OFFERED',
    "fareAmount" DECIMAL(14,2) NOT NULL,
    "platformFeeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fleetNetAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "externalReference" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FleetTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetSettlement" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "platformFeeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adjustmentsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "BankSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "paidAt" TIMESTAMPTZ(6),
    "paymentReference" TEXT,
    "paymentMethod" TEXT,
    "paidAmount" DECIMAL(14,2),
    "paymentProofRef" TEXT,
    "paymentNote" TEXT,
    "paidById" TEXT,
    "payoutAccountMasked" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetPartnerDocument" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "documentType" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "documentNumber" TEXT,
    "issuedAt" DATE,
    "expiresAt" DATE,
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedById" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "rejectionNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetPartnerDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankPartner" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "logoUrl" TEXT,
    "websiteUrl" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" "BankPartnerStatus" NOT NULL DEFAULT 'PROSPECT',
    "agreementReference" TEXT,
    "agreementStartAt" DATE,
    "agreementEndAt" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "webhookSecretEnc" TEXT,
    "webhookSecretVersion" INTEGER NOT NULL DEFAULT 0,
    "webhookSecretRotatedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BankPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankCampaign" (
    "id" TEXT NOT NULL,
    "bankPartnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignCode" TEXT NOT NULL,
    "description" TEXT,
    "status" "BankCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "budgetAmount" DECIMAL(14,2),
    "spentAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "landingPageUrl" TEXT,
    "attributionWindowDays" INTEGER NOT NULL DEFAULT 30,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankOffer" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortDescription" TEXT,
    "termsAndConditions" TEXT NOT NULL,
    "offerType" "BankOfferType" NOT NULL,
    "eligibilityType" "BankEligibilityType" NOT NULL DEFAULT 'BANK_APPROVAL_REQUIRED',
    "discountPercent" DECIMAL(7,4),
    "discountAmount" DECIMAL(14,2),
    "maxBenefitAmount" DECIMAL(14,2),
    "minTripAmount" DECIMAL(14,2),
    "redemptionLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "requiresBankApproval" BOOLEAN NOT NULL DEFAULT true,
    "accountOpeningUrl" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "displayPriority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankOfferClick" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousSession" TEXT,
    "attributionCode" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'RUNSERV_APP',
    "clickedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankOfferClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReferral" (
    "id" TEXT NOT NULL,
    "bankPartnerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "offerId" TEXT,
    "userId" TEXT,
    "clickId" TEXT,
    "referralCode" TEXT NOT NULL,
    "status" "BankReferralStatus" NOT NULL DEFAULT 'CLICKED',
    "bankExternalRef" TEXT,
    "applicationAt" TIMESTAMPTZ(6),
    "verifiedAt" TIMESTAMPTZ(6),
    "conversionValue" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankSettlement" (
    "id" TEXT NOT NULL,
    "bankPartnerId" TEXT NOT NULL,
    "campaignId" TEXT,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "agreedAmount" DECIMAL(14,2) NOT NULL,
    "adjustmentsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "BankSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceReference" TEXT,
    "paymentReference" TEXT,
    "receivedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankOfferDailyStat" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BankOfferDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRedemption" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "tripAmount" DECIMAL(14,2) NOT NULL,
    "benefitAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "BankRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReceivingAccount" (
    "id" TEXT NOT NULL,
    "bankPartnerId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankReceivingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankPayment" (
    "id" TEXT NOT NULL,
    "bankPartnerId" TEXT NOT NULL,
    "receivingAccountId" TEXT,
    "settlementId" TEXT,
    "source" "BankPaymentSource" NOT NULL DEFAULT 'WEBHOOK',
    "bankTransactionRef" TEXT NOT NULL,
    "paymentReference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "payerName" TEXT,
    "creditedAccount" TEXT,
    "paidAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BankPaymentStatus" NOT NULL,
    "exceptionReason" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolutionNote" TEXT,
    "companyId" TEXT,
    "invoiceId" TEXT,
    "enteredById" TEXT,
    "reviewFrom" "BankPaymentStatus",
    "proposal" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewNote" TEXT,
    "alertedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BankPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "entryGroup" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "memo" TEXT,
    "actorId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL,
    "bankPartnerId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "organisation" TEXT,
    "interest" TEXT NOT NULL,
    "message" TEXT,
    "status" "DemoRequestStatus" NOT NULL DEFAULT 'NEW',
    "ipHash" TEXT,
    "handledById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DemoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingMoneyAction" (
    "id" TEXT NOT NULL,
    "kind" "MoneyActionKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "status" "MoneyActionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "alertedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingMoneyAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "type" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderConfig" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "onboardingStatus" "ProviderOnboardingStatus" NOT NULL DEFAULT 'PLANNED',
    "capabilities" JSONB,
    "safeConfig" JSONB,
    "secretsEnc" JSONB,
    "secretsRotatedAt" TIMESTAMPTZ(6),
    "lastVerifiedAt" TIMESTAMPTZ(6),
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderChangeRequest" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MoneyActionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalEventId" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'NA',
    "outcome" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentException" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "detail" JSONB,
    "dedupeKey" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "periodFrom" TIMESTAMPTZ(6) NOT NULL,
    "periodTo" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "mismatched" INTEGER NOT NULL DEFAULT 0,
    "missingHere" INTEGER NOT NULL DEFAULT 0,
    "missingThere" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestIdentity" (
    "id" TEXT NOT NULL,
    "phone" TEXT,
    "countryCode" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(6) NOT NULL,
    "email" TEXT,
    "contactPhone" TEXT,
    "verifiedChannel" TEXT NOT NULL DEFAULT 'PHONE',
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "phoneVerifiedAt" TIMESTAMPTZ(6),
    "convertedAt" TIMESTAMPTZ(6),
    "blockedAt" TIMESTAMPTZ(6),
    "blockReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestOtp" (
    "id" TEXT NOT NULL,
    "phone" TEXT,
    "countryCode" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'PHONE',
    "purpose" TEXT NOT NULL DEFAULT 'GUEST_BOOKING_VERIFY',
    "identityKey" TEXT,
    "email" TEXT,
    "contactPhone" TEXT,
    "codeNonce" TEXT,
    "supersededAt" TIMESTAMPTZ(6),
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "ipHash" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestSession" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestBooking" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "rideId" TEXT,
    "deliveryId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "fare" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "trackingTokenHash" TEXT NOT NULL,
    "trackingNonce" TEXT NOT NULL,
    "trackingExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "trackingRevokedAt" TIMESTAMPTZ(6),
    "quoteSnapshot" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestAuditEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "identityId" TEXT,
    "bookingId" TEXT,
    "ipHash" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOutbox" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "kind" TEXT NOT NULL,
    "bookingId" TEXT,
    "deliveryId" TEXT,
    "toPhone" TEXT,
    "toMasked" TEXT NOT NULL,
    "countryCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerMessageId" TEXT,
    "deliveryStatus" TEXT,
    "deliveryAt" TIMESTAMPTZ(6),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "kind" TEXT NOT NULL,
    "otpId" TEXT,
    "bookingId" TEXT,
    "deliveryId" TEXT,
    "toEmail" TEXT,
    "toMasked" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT,
    "routeReason" TEXT,
    "slotHeld" BOOLEAN NOT NULL DEFAULT false,
    "providerMessageId" TEXT,
    "errorCategory" TEXT,
    "lastError" TEXT,
    "deliveryStatus" TEXT,
    "deliveryAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailQuotaWindow" (
    "provider" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "exhaustedAt" TIMESTAMPTZ(6),
    "unhealthyUntil" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmailQuotaWindow_pkey" PRIMARY KEY ("provider","windowKey")
);

-- CreateTable
CREATE TABLE "EmailProviderControl" (
    "provider" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMPTZ(6),
    "pausedBy" TEXT,

    CONSTRAINT "EmailProviderControl_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "EmailWebhookEvent" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "provider" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "messageId" TEXT,
    "event" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVariant" TEXT,
    "token" TEXT NOT NULL,
    "deviceId" TEXT,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstNotifiedAt" TIMESTAMPTZ(6),
    "lastNotifiedAt" TIMESTAMPTZ(6),
    "escalatedAt" TIMESTAMPTZ(6),
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolutionNote" TEXT,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertDelivery" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "alertId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerReconciliationRun" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "startedById" TEXT,
    "summary" JSONB,
    "exceptions" JSONB,
    "error" TEXT,

    CONSTRAINT "LedgerReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevokedToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'LOGOUT',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE INDEX "User_adminDepartment_idx" ON "User"("adminDepartment");

-- CreateIndex
CREATE INDEX "User_isDeleted_idx" ON "User"("isDeleted");

-- CreateIndex
CREATE INDEX "User_countryCode_idx" ON "User"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "OtpVerification_tempToken_key" ON "OtpVerification"("tempToken");

-- CreateIndex
CREATE INDEX "OtpVerification_tempToken_idx" ON "OtpVerification"("tempToken");

-- CreateIndex
CREATE INDEX "OtpVerification_userId_idx" ON "OtpVerification"("userId");

-- CreateIndex
CREATE INDEX "OtpVerification_expiresAt_idx" ON "OtpVerification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_userId_key" ON "DriverProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_licenseNumber_key" ON "DriverProfile"("licenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_vehiclePlate_key" ON "DriverProfile"("vehiclePlate");

-- CreateIndex
CREATE INDEX "DriverProfile_isApproved_idx" ON "DriverProfile"("isApproved");

-- CreateIndex
CREATE INDEX "DriverProfile_isRejected_idx" ON "DriverProfile"("isRejected");

-- CreateIndex
CREATE INDEX "DriverProfile_isOnline_currentLat_currentLng_idx" ON "DriverProfile"("isOnline", "currentLat", "currentLng");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPartnerProfile_userId_key" ON "DeliveryPartnerProfile"("userId");

-- CreateIndex
CREATE INDEX "DeliveryPartnerProfile_isApproved_idx" ON "DeliveryPartnerProfile"("isApproved");

-- CreateIndex
CREATE INDEX "DeliveryPartnerProfile_isRejected_idx" ON "DeliveryPartnerProfile"("isRejected");

-- CreateIndex
CREATE INDEX "DeliveryPartnerProfile_isOnline_currentLat_currentLng_idx" ON "DeliveryPartnerProfile"("isOnline", "currentLat", "currentLng");

-- CreateIndex
CREATE INDEX "Ride_customerId_idx" ON "Ride"("customerId");

-- CreateIndex
CREATE INDEX "Ride_driverId_idx" ON "Ride"("driverId");

-- CreateIndex
CREATE INDEX "Ride_status_idx" ON "Ride"("status");

-- CreateIndex
CREATE INDEX "Ride_requestedAt_idx" ON "Ride"("requestedAt");

-- CreateIndex
CREATE INDEX "Ride_isCorporate_idx" ON "Ride"("isCorporate");

-- CreateIndex
CREATE INDEX "Ride_companyId_idx" ON "Ride"("companyId");

-- CreateIndex
CREATE INDEX "Delivery_customerId_idx" ON "Delivery"("customerId");

-- CreateIndex
CREATE INDEX "Delivery_partnerId_idx" ON "Delivery"("partnerId");

-- CreateIndex
CREATE INDEX "Delivery_status_idx" ON "Delivery"("status");

-- CreateIndex
CREATE INDEX "Delivery_requestedAt_idx" ON "Delivery"("requestedAt");

-- CreateIndex
CREATE INDEX "Delivery_isCorporate_idx" ON "Delivery"("isCorporate");

-- CreateIndex
CREATE INDEX "Delivery_companyId_idx" ON "Delivery"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_rideId_key" ON "Payment"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_deliveryId_key" ON "Payment"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_transactionId_key" ON "Payment"("transactionId");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_provider_providerRef_idx" ON "Payment"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_userId_idempotencyKey_key" ON "Payment"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_rideId_key" ON "Rating"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_deliveryId_key" ON "Rating"("deliveryId");

-- CreateIndex
CREATE INDEX "Rating_userId_idx" ON "Rating"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_reference_key" ON "WalletTransaction"("reference");

-- CreateIndex
CREATE INDEX "WalletTransaction_walletId_idx" ON "WalletTransaction"("walletId");

-- CreateIndex
CREATE INDEX "WalletTransaction_type_idx" ON "WalletTransaction"("type");

-- CreateIndex
CREATE INDEX "WalletTransaction_createdAt_idx" ON "WalletTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "WalletTransaction_provider_idx" ON "WalletTransaction"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_reference_key" ON "Payout"("reference");

-- CreateIndex
CREATE INDEX "Payout_userId_idx" ON "Payout"("userId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_reference_key" ON "Transfer"("reference");

-- CreateIndex
CREATE INDEX "Transfer_senderId_idx" ON "Transfer"("senderId");

-- CreateIndex
CREATE INDEX "Transfer_recipientId_idx" ON "Transfer"("recipientId");

-- CreateIndex
CREATE INDEX "Transfer_status_idx" ON "Transfer"("status");

-- CreateIndex
CREATE INDEX "Transfer_createdAt_idx" ON "Transfer"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminProfile_userId_key" ON "AdminProfile"("userId");

-- CreateIndex
CREATE INDEX "AdminProfile_userId_idx" ON "AdminProfile"("userId");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_isRead_idx" ON "Notification"("isRead");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_idx" ON "ActivityLog"("userId");

-- CreateIndex
CREATE INDEX "ActivityLog_action_idx" ON "ActivityLog"("action");

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_idx" ON "ActivityLog"("entityType");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSettings_key_key" ON "SystemSettings"("key");

-- CreateIndex
CREATE INDEX "SystemSettings_category_idx" ON "SystemSettings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Country_code_key" ON "Country"("code");

-- CreateIndex
CREATE INDEX "Country_isActive_idx" ON "Country"("isActive");

-- CreateIndex
CREATE INDEX "CountrySetting_countryCode_idx" ON "CountrySetting"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "CountrySetting_countryCode_key_key" ON "CountrySetting"("countryCode", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoCode_code_idx" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoCode_isActive_idx" ON "PromoCode"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketNumber_key" ON "SupportTicket"("ticketNumber");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_idx" ON "SupportTicket"("userId");

-- CreateIndex
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX "SupportTicket_priority_idx" ON "SupportTicket"("priority");

-- CreateIndex
CREATE INDEX "SupportTicket_assignedTo_idx" ON "SupportTicket"("assignedTo");

-- CreateIndex
CREATE INDEX "SupportTicket_createdAt_idx" ON "SupportTicket"("createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_countryCode_idx" ON "SupportTicket"("countryCode");

-- CreateIndex
CREATE INDEX "SupportTicket_language_idx" ON "SupportTicket"("language");

-- CreateIndex
CREATE INDEX "TicketReply_ticketId_idx" ON "TicketReply"("ticketId");

-- CreateIndex
CREATE INDEX "TicketReply_authorId_idx" ON "TicketReply"("authorId");

-- CreateIndex
CREATE INDEX "AppFeedback_userId_idx" ON "AppFeedback"("userId");

-- CreateIndex
CREATE INDEX "AppFeedback_rating_idx" ON "AppFeedback"("rating");

-- CreateIndex
CREATE INDEX "AppFeedback_createdAt_idx" ON "AppFeedback"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionLedger_paymentId_key" ON "CommissionLedger"("paymentId");

-- CreateIndex
CREATE INDEX "CommissionLedger_serviceType_idx" ON "CommissionLedger"("serviceType");

-- CreateIndex
CREATE INDEX "CommissionLedger_earnerUserId_idx" ON "CommissionLedger"("earnerUserId");

-- CreateIndex
CREATE INDEX "CommissionLedger_createdAt_idx" ON "CommissionLedger"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_rcNumber_key" ON "Company"("rcNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Company_email_key" ON "Company"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Company_orgCode_key" ON "Company"("orgCode");

-- CreateIndex
CREATE UNIQUE INDEX "Company_payReference_key" ON "Company"("payReference");

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Company_customDomain_key" ON "Company"("customDomain");

-- CreateIndex
CREATE INDEX "Company_status_idx" ON "Company"("status");

-- CreateIndex
CREATE INDEX "Company_ownerUserId_idx" ON "Company"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgWalletTx_reference_key" ON "OrgWalletTx"("reference");

-- CreateIndex
CREATE INDEX "OrgWalletTx_companyId_createdAt_idx" ON "OrgWalletTx"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Department_companyId_idx" ON "Department"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_name_key" ON "Department"("companyId", "name");

-- CreateIndex
CREATE INDEX "StaffDirectoryEntry_companyId_status_idx" ON "StaffDirectoryEntry"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StaffDirectoryEntry_companyId_staffNumber_key" ON "StaffDirectoryEntry"("companyId", "staffNumber");

-- CreateIndex
CREATE INDEX "CompanyEmployee_companyId_idx" ON "CompanyEmployee"("companyId");

-- CreateIndex
CREATE INDEX "CompanyEmployee_userId_idx" ON "CompanyEmployee"("userId");

-- CreateIndex
CREATE INDEX "CompanyEmployee_staffNo_idx" ON "CompanyEmployee"("companyId", "staffNumber");

-- CreateIndex
CREATE INDEX "CompanyEmployee_departmentId_idx" ON "CompanyEmployee"("departmentId");

-- CreateIndex
CREATE INDEX "CompanyEmployee_supervisorId_idx" ON "CompanyEmployee"("supervisorId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEmployee_unique" ON "CompanyEmployee"("companyId", "userId");

-- CreateIndex
CREATE INDEX "WeekendRideRequest_companyId_status_idx" ON "WeekendRideRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "WeekendRideRequest_employeeId_requestedDate_idx" ON "WeekendRideRequest"("employeeId", "requestedDate");

-- CreateIndex
CREATE INDEX "ApprovalRequest_companyId_status_idx" ON "ApprovalRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_employeeId_status_idx" ON "ApprovalRequest"("employeeId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_approverEmployeeId_status_idx" ON "ApprovalRequest"("approverEmployeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateTrip_rideId_key" ON "CorporateTrip"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateTrip_delId_key" ON "CorporateTrip"("deliveryId");

-- CreateIndex
CREATE INDEX "CorporateTrip_companyId_idx" ON "CorporateTrip"("companyId");

-- CreateIndex
CREATE INDEX "CorporateTrip_employeeId_idx" ON "CorporateTrip"("employeeId");

-- CreateIndex
CREATE INDEX "CorporateTrip_createdAt_idx" ON "CorporateTrip"("createdAt");

-- CreateIndex
CREATE INDEX "CorporateTrip_companyId_tripAt_idx" ON "CorporateTrip"("companyId", "tripAt");

-- CreateIndex
CREATE INDEX "CorporateTrip_companyId_departmentId_tripAt_idx" ON "CorporateTrip"("companyId", "departmentId", "tripAt");

-- CreateIndex
CREATE INDEX "CorporateTrip_status_idx" ON "CorporateTrip"("status");

-- CreateIndex
CREATE INDEX "CorporateTrip_invoiceId_idx" ON "CorporateTrip"("invoiceId");

-- CreateIndex
CREATE INDEX "CorporateTrip_earnerUserId_payoutStatus_idx" ON "CorporateTrip"("earnerUserId", "payoutStatus");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyInvoice_invoiceNumber_key" ON "CompanyInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyInvoice_paymentReference_key" ON "CompanyInvoice"("paymentReference");

-- CreateIndex
CREATE INDEX "CompanyInvoice_status_idx" ON "CompanyInvoice"("status");

-- CreateIndex
CREATE INDEX "CompanyInvoice_dueDate_idx" ON "CompanyInvoice"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyInvoice_company_period_key" ON "CompanyInvoice"("companyId", "period");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgPayout_walletReference_key" ON "OrgPayout"("walletReference");

-- CreateIndex
CREATE INDEX "OrgPayout_userId_status_idx" ON "OrgPayout"("userId", "status");

-- CreateIndex
CREATE INDEX "OrgPayout_companyId_idx" ON "OrgPayout"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgPayout_invoice_user_key" ON "OrgPayout"("invoiceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetPartner_rcNumber_key" ON "FleetPartner"("rcNumber");

-- CreateIndex
CREATE INDEX "FleetPartner_status_idx" ON "FleetPartner"("status");

-- CreateIndex
CREATE INDEX "FleetPartner_ownerUserId_idx" ON "FleetPartner"("ownerUserId");

-- CreateIndex
CREATE INDEX "FleetPartner_countryCode_status_idx" ON "FleetPartner"("countryCode", "status");

-- CreateIndex
CREATE INDEX "FleetPartnerUser_userId_isActive_idx" ON "FleetPartnerUser"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FleetPartnerUser_fleetPartnerId_userId_key" ON "FleetPartnerUser"("fleetPartnerId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetInvitation_tokenHash_key" ON "FleetInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "FleetInvitation_fleetPartnerId_status_idx" ON "FleetInvitation"("fleetPartnerId", "status");

-- CreateIndex
CREATE INDEX "FleetInvitation_email_status_idx" ON "FleetInvitation"("email", "status");

-- CreateIndex
CREATE INDEX "FleetShift_fleetPartnerId_startsAt_idx" ON "FleetShift"("fleetPartnerId", "startsAt");

-- CreateIndex
CREATE INDEX "FleetShift_driverUserId_startsAt_idx" ON "FleetShift"("driverUserId", "startsAt");

-- CreateIndex
CREATE INDEX "FleetShift_vehicleId_startsAt_idx" ON "FleetShift"("vehicleId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetVehicle_registrationNumber_key" ON "FleetVehicle"("registrationNumber");

-- CreateIndex
CREATE INDEX "FleetVehicle_fleetPartnerId_status_idx" ON "FleetVehicle"("fleetPartnerId", "status");

-- CreateIndex
CREATE INDEX "FleetDriverAssignment_fleetPartnerId_status_idx" ON "FleetDriverAssignment"("fleetPartnerId", "status");

-- CreateIndex
CREATE INDEX "FleetDriverAssignment_vehicleId_status_idx" ON "FleetDriverAssignment"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "FleetDriverAssignment_driverUserId_status_idx" ON "FleetDriverAssignment"("driverUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FleetTrip_rideId_key" ON "FleetTrip"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetTrip_deliveryId_key" ON "FleetTrip"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetTrip_externalReference_key" ON "FleetTrip"("externalReference");

-- CreateIndex
CREATE INDEX "FleetTrip_fleetPartnerId_createdAt_idx" ON "FleetTrip"("fleetPartnerId", "createdAt");

-- CreateIndex
CREATE INDEX "FleetTrip_driverUserId_status_idx" ON "FleetTrip"("driverUserId", "status");

-- CreateIndex
CREATE INDEX "FleetTrip_vehicleId_status_idx" ON "FleetTrip"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "FleetTrip_status_createdAt_idx" ON "FleetTrip"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetSettlement_reference_key" ON "FleetSettlement"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "FleetSettlement_paymentReference_key" ON "FleetSettlement"("paymentReference");

-- CreateIndex
CREATE INDEX "FleetSettlement_fleetPartnerId_status_idx" ON "FleetSettlement"("fleetPartnerId", "status");

-- CreateIndex
CREATE INDEX "FleetSettlement_periodStart_periodEnd_idx" ON "FleetSettlement"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "FleetPartnerDocument_fleetPartnerId_documentType_idx" ON "FleetPartnerDocument"("fleetPartnerId", "documentType");

-- CreateIndex
CREATE INDEX "FleetPartnerDocument_vehicleId_expiresAt_idx" ON "FleetPartnerDocument"("vehicleId", "expiresAt");

-- CreateIndex
CREATE INDEX "BankPartner_countryCode_status_idx" ON "BankPartner"("countryCode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankCampaign_campaignCode_key" ON "BankCampaign"("campaignCode");

-- CreateIndex
CREATE INDEX "BankCampaign_bankPartnerId_status_idx" ON "BankCampaign"("bankPartnerId", "status");

-- CreateIndex
CREATE INDEX "BankCampaign_startsAt_endsAt_idx" ON "BankCampaign"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "BankOffer_campaignId_isPublished_displayPriority_idx" ON "BankOffer"("campaignId", "isPublished", "displayPriority");

-- CreateIndex
CREATE UNIQUE INDEX "BankOfferClick_attributionCode_key" ON "BankOfferClick"("attributionCode");

-- CreateIndex
CREATE INDEX "BankOfferClick_offerId_clickedAt_idx" ON "BankOfferClick"("offerId", "clickedAt");

-- CreateIndex
CREATE INDEX "BankOfferClick_userId_clickedAt_idx" ON "BankOfferClick"("userId", "clickedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankReferral_clickId_key" ON "BankReferral"("clickId");

-- CreateIndex
CREATE UNIQUE INDEX "BankReferral_referralCode_key" ON "BankReferral"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "BankReferral_bankExternalRef_key" ON "BankReferral"("bankExternalRef");

-- CreateIndex
CREATE INDEX "BankReferral_bankPartnerId_status_createdAt_idx" ON "BankReferral"("bankPartnerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BankReferral_campaignId_status_idx" ON "BankReferral"("campaignId", "status");

-- CreateIndex
CREATE INDEX "BankReferral_userId_createdAt_idx" ON "BankReferral"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankSettlement_invoiceReference_key" ON "BankSettlement"("invoiceReference");

-- CreateIndex
CREATE UNIQUE INDEX "BankSettlement_paymentReference_key" ON "BankSettlement"("paymentReference");

-- CreateIndex
CREATE INDEX "BankSettlement_bankPartnerId_status_idx" ON "BankSettlement"("bankPartnerId", "status");

-- CreateIndex
CREATE INDEX "BankSettlement_periodStart_periodEnd_idx" ON "BankSettlement"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "BankOfferDailyStat_campaignId_day_idx" ON "BankOfferDailyStat"("campaignId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "BankOfferDailyStat_offerId_day_key" ON "BankOfferDailyStat"("offerId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "BankRedemption_idempotencyKey_key" ON "BankRedemption"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BankRedemption_offerId_userId_status_idx" ON "BankRedemption"("offerId", "userId", "status");

-- CreateIndex
CREATE INDEX "BankRedemption_campaignId_status_idx" ON "BankRedemption"("campaignId", "status");

-- CreateIndex
CREATE INDEX "BankReceivingAccount_bankPartnerId_isActive_idx" ON "BankReceivingAccount"("bankPartnerId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BankReceivingAccount_bankPartnerId_accountNumber_key" ON "BankReceivingAccount"("bankPartnerId", "accountNumber");

-- CreateIndex
CREATE INDEX "BankPayment_status_receivedAt_idx" ON "BankPayment"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "BankPayment_settlementId_idx" ON "BankPayment"("settlementId");

-- CreateIndex
CREATE INDEX "BankPayment_companyId_idx" ON "BankPayment"("companyId");

-- CreateIndex
CREATE INDEX "BankPayment_invoiceId_idx" ON "BankPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "BankPayment_bankPartnerId_receivedAt_idx" ON "BankPayment"("bankPartnerId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankPayment_bankPartnerId_bankTransactionRef_key" ON "BankPayment"("bankPartnerId", "bankTransactionRef");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_account_createdAt_idx" ON "LedgerEntry"("account", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_refType_refId_idx" ON "LedgerEntry"("refType", "refId");

-- CreateIndex
CREATE INDEX "LedgerEntry_entryGroup_idx" ON "LedgerEntry"("entryGroup");

-- CreateIndex
CREATE INDEX "StatementImport_createdAt_idx" ON "StatementImport"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_bankPartnerId_sha256_key" ON "StatementImport"("bankPartnerId", "sha256");

-- CreateIndex
CREATE INDEX "DemoRequest_status_createdAt_idx" ON "DemoRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DemoRequest_email_idx" ON "DemoRequest"("email");

-- CreateIndex
CREATE INDEX "PendingMoneyAction_status_createdAt_idx" ON "PendingMoneyAction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PendingMoneyAction_targetId_idx" ON "PendingMoneyAction"("targetId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_type_aggregateType_aggregateId_key" ON "OutboxEvent"("type", "aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "PaymentProviderConfig_providerKey_enabled_idx" ON "PaymentProviderConfig"("providerKey", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderConfig_providerKey_countryCode_environment_key" ON "PaymentProviderConfig"("providerKey", "countryCode", "environment");

-- CreateIndex
CREATE INDEX "ProviderChangeRequest_status_createdAt_idx" ON "ProviderChangeRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_paymentId_createdAt_idx" ON "PaymentEvent"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_provider_createdAt_idx" ON "PaymentEvent"("provider", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_provider_externalEventId_key" ON "PaymentEvent"("provider", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentException_dedupeKey_key" ON "PaymentException"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaymentException_status_createdAt_idx" ON "PaymentException"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentException_provider_kind_idx" ON "PaymentException"("provider", "kind");

-- CreateIndex
CREATE INDEX "ReconciliationRun_provider_createdAt_idx" ON "ReconciliationRun"("provider", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestIdentity_phone_key" ON "GuestIdentity"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "GuestIdentity_userId_key" ON "GuestIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestIdentity_email_key" ON "GuestIdentity"("email");

-- CreateIndex
CREATE INDEX "GuestIdentity_createdAt_idx" ON "GuestIdentity"("createdAt");

-- CreateIndex
CREATE INDEX "GuestOtp_phone_createdAt_idx" ON "GuestOtp"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "GuestOtp_identityKey_purpose_createdAt_idx" ON "GuestOtp"("identityKey", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "GuestOtp_ipHash_createdAt_idx" ON "GuestOtp"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "GuestOtp_expiresAt_idx" ON "GuestOtp"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestSession_tokenHash_key" ON "GuestSession"("tokenHash");

-- CreateIndex
CREATE INDEX "GuestSession_identityId_idx" ON "GuestSession"("identityId");

-- CreateIndex
CREATE INDEX "GuestSession_expiresAt_idx" ON "GuestSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestBooking_reference_key" ON "GuestBooking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "GuestBooking_rideId_key" ON "GuestBooking"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestBooking_deliveryId_key" ON "GuestBooking"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestBooking_quoteId_key" ON "GuestBooking"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestBooking_trackingTokenHash_key" ON "GuestBooking"("trackingTokenHash");

-- CreateIndex
CREATE INDEX "GuestBooking_identityId_createdAt_idx" ON "GuestBooking"("identityId", "createdAt");

-- CreateIndex
CREATE INDEX "GuestBooking_createdAt_idx" ON "GuestBooking"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestBooking_identityId_idempotencyKey_key" ON "GuestBooking"("identityId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "GuestAuditEvent_identityId_createdAt_idx" ON "GuestAuditEvent"("identityId", "createdAt");

-- CreateIndex
CREATE INDEX "GuestAuditEvent_bookingId_idx" ON "GuestAuditEvent"("bookingId");

-- CreateIndex
CREATE INDEX "GuestAuditEvent_event_createdAt_idx" ON "GuestAuditEvent"("event", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SmsOutbox_idempotencyKey_key" ON "SmsOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SmsOutbox_status_nextAttemptAt_idx" ON "SmsOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SmsOutbox_bookingId_idx" ON "SmsOutbox"("bookingId");

-- CreateIndex
CREATE INDEX "SmsOutbox_deliveryId_idx" ON "SmsOutbox"("deliveryId");

-- CreateIndex
CREATE INDEX "SmsOutbox_providerMessageId_idx" ON "SmsOutbox"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsOutbox_kind_bookingId_key" ON "SmsOutbox"("kind", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsOutbox_kind_deliveryId_key" ON "SmsOutbox"("kind", "deliveryId");

-- CreateIndex
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_otpId_idx" ON "EmailOutbox"("otpId");

-- CreateIndex
CREATE INDEX "EmailOutbox_bookingId_kind_createdAt_idx" ON "EmailOutbox"("bookingId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_deliveryId_kind_createdAt_idx" ON "EmailOutbox"("deliveryId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_kind_status_createdAt_idx" ON "EmailOutbox"("kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_providerMessageId_idx" ON "EmailOutbox"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailWebhookEvent_provider_eventKey_key" ON "EmailWebhookEvent"("provider", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_revokedAt_idx" ON "DeviceToken"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "DeviceToken_deviceId_idx" ON "DeviceToken"("deviceId");

-- CreateIndex
CREATE INDEX "OpsAlert_status_createdAt_idx" ON "OpsAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAlert_dedupeKey_status_idx" ON "OpsAlert"("dedupeKey", "status");

-- CreateIndex
CREATE INDEX "OpsAlert_kind_idx" ON "OpsAlert"("kind");

-- CreateIndex
CREATE INDEX "OpsAlertDelivery_alertId_idx" ON "OpsAlertDelivery"("alertId");

-- CreateIndex
CREATE INDEX "OpsAlertDelivery_status_nextAttemptAt_idx" ON "OpsAlertDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "LedgerReconciliationRun_startedAt_idx" ON "LedgerReconciliationRun"("startedAt");

-- CreateIndex
CREATE INDEX "LedgerReconciliationRun_status_idx" ON "LedgerReconciliationRun"("status");

-- CreateIndex
CREATE INDEX "RevokedToken_userId_idx" ON "RevokedToken"("userId");

-- CreateIndex
CREATE INDEX "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "OtpVerification" ADD CONSTRAINT "OtpVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DeliveryPartnerProfile" ADD CONSTRAINT "DeliveryPartnerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdminProfile" ADD CONSTRAINT "AdminProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "TicketReply" ADD CONSTRAINT "TicketReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "TicketReply" ADD CONSTRAINT "TicketReply_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AppFeedback" ADD CONSTRAINT "AppFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_earnerUserId_fkey" FOREIGN KEY ("earnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrgWalletTx" ADD CONSTRAINT "OrgWalletTx_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_headEmployeeId_fkey" FOREIGN KEY ("headEmployeeId") REFERENCES "CompanyEmployee"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StaffDirectoryEntry" ADD CONSTRAINT "StaffDirectoryEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StaffDirectoryEntry" ADD CONSTRAINT "StaffDirectoryEntry_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompanyEmployee" ADD CONSTRAINT "CompanyEmployee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompanyEmployee" ADD CONSTRAINT "CompanyEmployee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompanyEmployee" ADD CONSTRAINT "CompanyEmployee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompanyEmployee" ADD CONSTRAINT "CompanyEmployee_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "CompanyEmployee"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WeekendRideRequest" ADD CONSTRAINT "WeekendRideRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WeekendRideRequest" ADD CONSTRAINT "WeekendRideRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "CompanyEmployee"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "CompanyEmployee"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CorporateTrip" ADD CONSTRAINT "CorporateTrip_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CorporateTrip" ADD CONSTRAINT "CorporateTrip_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CorporateTrip" ADD CONSTRAINT "CorporateTrip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "CompanyEmployee"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CorporateTrip" ADD CONSTRAINT "CorporateTrip_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CorporateTrip" ADD CONSTRAINT "CorporateTrip_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CompanyInvoice"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CorporateTrip" ADD CONSTRAINT "CorporateTrip_orgPayoutId_fkey" FOREIGN KEY ("orgPayoutId") REFERENCES "OrgPayout"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompanyInvoice" ADD CONSTRAINT "CompanyInvoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CompanyInvoice"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrgPayout" ADD CONSTRAINT "OrgPayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrgPayout" ADD CONSTRAINT "OrgPayout_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrgPayout" ADD CONSTRAINT "OrgPayout_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CompanyInvoice"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FleetPartner" ADD CONSTRAINT "FleetPartner_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerUser" ADD CONSTRAINT "FleetPartnerUser_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerUser" ADD CONSTRAINT "FleetPartnerUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetInvitation" ADD CONSTRAINT "FleetInvitation_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetShift" ADD CONSTRAINT "FleetShift_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetVehicle" ADD CONSTRAINT "FleetVehicle_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetDriverAssignment" ADD CONSTRAINT "FleetDriverAssignment_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetDriverAssignment" ADD CONSTRAINT "FleetDriverAssignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "FleetVehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetDriverAssignment" ADD CONSTRAINT "FleetDriverAssignment_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetTrip" ADD CONSTRAINT "FleetTrip_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetTrip" ADD CONSTRAINT "FleetTrip_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetTrip" ADD CONSTRAINT "FleetTrip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "FleetVehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetSettlement" ADD CONSTRAINT "FleetSettlement_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerDocument" ADD CONSTRAINT "FleetPartnerDocument_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerDocument" ADD CONSTRAINT "FleetPartnerDocument_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "FleetVehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankCampaign" ADD CONSTRAINT "BankCampaign_bankPartnerId_fkey" FOREIGN KEY ("bankPartnerId") REFERENCES "BankPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankCampaign" ADD CONSTRAINT "BankCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankOffer" ADD CONSTRAINT "BankOffer_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BankCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankOfferClick" ADD CONSTRAINT "BankOfferClick_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BankOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankOfferClick" ADD CONSTRAINT "BankOfferClick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReferral" ADD CONSTRAINT "BankReferral_bankPartnerId_fkey" FOREIGN KEY ("bankPartnerId") REFERENCES "BankPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReferral" ADD CONSTRAINT "BankReferral_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BankCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReferral" ADD CONSTRAINT "BankReferral_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BankOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReferral" ADD CONSTRAINT "BankReferral_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReferral" ADD CONSTRAINT "BankReferral_clickId_fkey" FOREIGN KEY ("clickId") REFERENCES "BankOfferClick"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankSettlement" ADD CONSTRAINT "BankSettlement_bankPartnerId_fkey" FOREIGN KEY ("bankPartnerId") REFERENCES "BankPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankSettlement" ADD CONSTRAINT "BankSettlement_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BankCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankOfferDailyStat" ADD CONSTRAINT "BankOfferDailyStat_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BankOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankOfferDailyStat" ADD CONSTRAINT "BankOfferDailyStat_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BankCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRedemption" ADD CONSTRAINT "BankRedemption_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BankOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRedemption" ADD CONSTRAINT "BankRedemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BankCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRedemption" ADD CONSTRAINT "BankRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReceivingAccount" ADD CONSTRAINT "BankReceivingAccount_bankPartnerId_fkey" FOREIGN KEY ("bankPartnerId") REFERENCES "BankPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankPayment" ADD CONSTRAINT "BankPayment_bankPartnerId_fkey" FOREIGN KEY ("bankPartnerId") REFERENCES "BankPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankPayment" ADD CONSTRAINT "BankPayment_receivingAccountId_fkey" FOREIGN KEY ("receivingAccountId") REFERENCES "BankReceivingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankPayment" ADD CONSTRAINT "BankPayment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "BankSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PaymentException" ADD CONSTRAINT "PaymentException_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GuestIdentity" ADD CONSTRAINT "GuestIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GuestSession" ADD CONSTRAINT "GuestSession_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "GuestIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestBooking" ADD CONSTRAINT "GuestBooking_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "GuestIdentity"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GuestBooking" ADD CONSTRAINT "GuestBooking_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GuestBooking" ADD CONSTRAINT "GuestBooking_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- Run AFTER the Prisma migration that creates the Fleet/Bank tables.
-- Prisma cannot express partial unique indexes, so add this to the generated
-- migration.sql (or run it as its own reviewed migration).
--
-- Guarantees at most one ACTIVE assignment per vehicle and per driver.

CREATE UNIQUE INDEX IF NOT EXISTS "FleetDriverAssignment_one_active_per_vehicle"
  ON "FleetDriverAssignment" ("vehicleId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS "FleetDriverAssignment_one_active_per_driver"
  ON "FleetDriverAssignment" ("driverUserId")
  WHERE "status" = 'ACTIVE';

-- ── Money safety nets (safe to run twice) ─────────────────────────────────────────────────────────────────────────────
-- A wallet can never go below zero, whatever a bug or a race tries. The application already debits with one conditional
-- update; this makes the database refuse an overdraw even if some future code path forgets. If the statement fails, some
-- existing wallet is already negative: fix those rows first (SELECT * FROM "Wallet" WHERE balance < 0).
DO $$ BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_nonnegative" CHECK (balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bank receipts: amounts must be positive; a settlement's received total can never be negative.
DO $$ BEGIN
  ALTER TABLE "BankPayment" ADD CONSTRAINT "BankPayment_amount_positive" CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BankSettlement" ADD CONSTRAINT "BankSettlement_received_nonnegative" CHECK ("receivedAmount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- M7: ledger that cannot be edited, row-level security for Supabase, integrity view
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- The financial ledger is append-only. UPDATE, DELETE and TRUNCATE are refused by the database itself, whoever asks.
CREATE OR REPLACE FUNCTION ledger_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only: correct a mistake with a new, opposite entry';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_no_update   ON "LedgerEntry";
DROP TRIGGER IF EXISTS ledger_no_truncate ON "LedgerEntry";
CREATE TRIGGER ledger_no_update   BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW       EXECUTE FUNCTION ledger_block_change();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE         ON "LedgerEntry" FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_change();

DO $$ BEGIN
  ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_positive" CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every event's debits must equal its credits. This view must ALWAYS be empty; alert if it is not.
CREATE OR REPLACE VIEW ledger_unbalanced_groups AS
  SELECT "entryGroup", currency,
         SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END) AS debits,
         SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS credits
    FROM "LedgerEntry"
   GROUP BY "entryGroup", currency
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END);

-- A statement can only be imported once per bank (also enforced in the schema; kept here as documentation of intent).

-- ── Supabase: nothing is readable through the public Data API ───────────────────────────────────────────────────────
-- Supabase exposes every table in the "public" schema over its REST API to the anon / authenticated roles. This application talks to
-- the database only through its own server (as the owner role, which is not affected by row-level security), so switch RLS on for
-- every table with NO policies: the Data API can then read and write nothing, even with the public anon key.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
  END IF;
END $$;

-- ── Multi-provider payments: PaymentEvent is an append-only evidence trail (like LedgerEntry). Correct with a NEW event. ──
CREATE OR REPLACE FUNCTION payment_event_block_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'PaymentEvent is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_event_no_update ON "PaymentEvent";
DROP TRIGGER IF EXISTS payment_event_no_truncate ON "PaymentEvent";
CREATE TRIGGER payment_event_no_update   BEFORE UPDATE OR DELETE ON "PaymentEvent" FOR EACH ROW       EXECUTE FUNCTION payment_event_block_change();
CREATE TRIGGER payment_event_no_truncate BEFORE TRUNCATE         ON "PaymentEvent" FOR EACH STATEMENT EXECUTE FUNCTION payment_event_block_change();
