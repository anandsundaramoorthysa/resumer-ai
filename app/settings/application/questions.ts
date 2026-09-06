/**
 * The reserved application-form questions — REQ-1.3.
 *
 * Kept as data rather than as markup so the Phase 10 autofill (Module 11) can map a
 * portal's field to an answer by id, without a second list to keep in step with this one.
 *
 * Every option list ends with an explicit decline. On a real application these questions
 * are voluntary, and an app that stores them should not be the thing that removes the
 * option not to answer.
 */

export interface FieldOption {
  value: string;
  label: string;
}

export interface EeoQuestion {
  id: string;
  label: string;
  help?: string;
  options: FieldOption[];
}

export const WORK_AUTHORIZATION_OPTIONS: FieldOption[] = [
  { value: '', label: 'Not answered' },
  { value: 'citizen', label: 'Citizen or national' },
  { value: 'permanent-resident', label: 'Permanent resident' },
  { value: 'work-visa', label: 'Authorized on a work visa' },
  { value: 'student-visa', label: 'Authorized on a student visa (OPT/CPT or equivalent)' },
  { value: 'not-authorized', label: 'Not currently authorized' },
];

export const EEO_QUESTIONS: EeoQuestion[] = [
  {
    id: 'gender',
    label: 'Gender',
    options: [
      { value: '', label: 'Not answered' },
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
      { value: 'non-binary', label: 'Non-binary' },
      { value: 'decline', label: 'Prefer not to say' },
    ],
  },
  {
    id: 'ethnicity',
    label: 'Race or ethnicity',
    options: [
      { value: '', label: 'Not answered' },
      { value: 'asian', label: 'Asian' },
      { value: 'black', label: 'Black or African American' },
      { value: 'hispanic', label: 'Hispanic or Latino' },
      { value: 'native-american', label: 'American Indian or Alaska Native' },
      { value: 'pacific-islander', label: 'Native Hawaiian or Pacific Islander' },
      { value: 'white', label: 'White' },
      { value: 'two-or-more', label: 'Two or more races' },
      { value: 'decline', label: 'Prefer not to say' },
    ],
  },
  {
    id: 'veteran',
    label: 'Veteran status',
    options: [
      { value: '', label: 'Not answered' },
      { value: 'protected-veteran', label: 'I identify as a protected veteran' },
      { value: 'not-veteran', label: 'I am not a protected veteran' },
      { value: 'decline', label: 'Prefer not to say' },
    ],
  },
  {
    id: 'disability',
    label: 'Disability status',
    options: [
      { value: '', label: 'Not answered' },
      { value: 'yes', label: 'Yes, I have or have had a disability' },
      { value: 'no', label: 'No, I do not' },
      { value: 'decline', label: 'Prefer not to say' },
    ],
  },
];
