// Hand-rolled types for the subset of Square fields we read.
// Reference shapes: SQUARE_REFERENCE.md section 5.
//
// We intentionally do NOT depend on @square/square — we want a tiny dep tree
// and only type the fields we actually consume. If Square adds fields we use
// later, extend this file.

// ---------- Square API errors ----------

export interface SquareErrorBody {
  category: string;
  code: string;
  detail?: string;
  field?: string;
}

export interface SquareErrorResponse {
  errors: SquareErrorBody[];
}

// ---------- Money ----------

export interface SquareMoney {
  amount?: number;
  currency?: string;
}

// ---------- Locations ----------

export type DayOfWeek = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

export interface BusinessHoursPeriod {
  day_of_week: DayOfWeek;
  start_local_time: string;
  end_local_time: string;
}

export interface BusinessHours {
  periods?: BusinessHoursPeriod[];
}

export interface Location {
  id: string;
  name: string;
  business_name?: string;
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  address?: {
    address_line_1?: string;
    locality?: string;
    administrative_district_level_1?: string;
    postal_code?: string;
    country?: string;
  };
  phone_number?: string;
  business_hours?: BusinessHours;
}

export interface ListLocationsResponse {
  locations?: Location[];
}

// ---------- Team members ----------

export interface TeamMember {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  status: 'ACTIVE' | 'INACTIVE';
  is_owner?: boolean;
}

export interface SearchTeamMembersResponse {
  team_members?: TeamMember[];
  cursor?: string;
}

export interface Barber {
  id: string;
  givenName: string;
  familyName: string;
  displayName: string;
  role: string;
}

// ---------- Catalog ----------

export type ServiceVariationPricingType = 'FIXED_PRICING' | 'VARIABLE_PRICING';

export interface CatalogItemVariation {
  type: 'ITEM_VARIATION';
  id: string;
  version: number;
  is_deleted?: boolean;
  item_variation_data: {
    item_id: string;
    name?: string;
    pricing_type: ServiceVariationPricingType;
    price_money?: SquareMoney;
    service_duration?: number;
    available_for_booking?: boolean;
    team_member_ids?: string[];
  };
}

export interface CatalogItem {
  type: 'ITEM';
  id: string;
  version: number;
  is_deleted?: boolean;
  item_data: {
    name?: string;
    description?: string;
    product_type?: string;
    variations?: CatalogItemVariation[];
  };
}

export type CatalogObject = CatalogItem | CatalogItemVariation;

export interface ListCatalogResponse {
  objects?: CatalogObject[];
  cursor?: string;
}

// ---------- Derived UI shapes ----------

export interface ServiceVariation {
  id: string;
  name: string;
  priceCents: number | null;
  durationMinutes: number;
  version: number;
  eligibleTeamMemberIds: string[];
  pricingType: ServiceVariationPricingType;
  availableForBooking: boolean;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  variations: ServiceVariation[];
  hasPerBarberVariations: boolean;
  minPriceCents: number | null;
  maxPriceCents: number | null;
}

export interface AvailabilitySlot {
  startAtUtc: string;
  startAtLocal: string;
  startTimeLabel: string;
  dateKey: string;
  teamMemberId: string;
  serviceVariationId: string;
  durationMinutes: number;
}

// ---------- Bookings ----------

export interface AppointmentSegment {
  duration_minutes: number;
  service_variation_id: string;
  service_variation_version: number;
  team_member_id: string;
}

export interface Booking {
  id: string;
  version: number;
  status:
    | 'PENDING'
    | 'ACCEPTED'
    | 'CANCELLED_BY_CUSTOMER'
    | 'CANCELLED_BY_SELLER'
    | 'DECLINED'
    | 'NO_SHOW';
  start_at: string;
  location_id: string;
  customer_id?: string;
  customer_note?: string;
  appointment_segments?: AppointmentSegment[];
  created_at?: string;
  updated_at?: string;
}

export interface CreateBookingResponse {
  booking?: Booking;
}

export interface ListBookingsResponse {
  bookings?: Booking[];
  cursor?: string;
}

// ---------- Customers ----------

export interface Customer {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
  created_at?: string;
}

export interface SearchCustomersResponse {
  customers?: Customer[];
  cursor?: string;
}

export interface CreateCustomerResponse {
  customer?: Customer;
}

export interface UpdateCustomerResponse {
  customer?: Customer;
}

// ---------- Availability ----------

export interface AvailabilityResponse {
  availabilities?: Array<{
    start_at: string;
    location_id?: string;
    appointment_segments?: Array<{
      duration_minutes?: number;
      service_variation_id: string;
      service_variation_version?: number;
      team_member_id: string;
    }>;
  }>;
}
