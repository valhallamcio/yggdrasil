import { BaseRepository } from '../../repositories/base.repository.js';
import type { DonationDocument } from './donations.types.js';

export class DonationsRepository extends BaseRepository<DonationDocument> {
  constructor() {
    super('donations');
  }
}
