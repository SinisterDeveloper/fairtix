'use client';

import type { TicketState } from '@/lib/types';

export default function StadiumSeating({
  capacity,
  tickets,
  selectedSeat,
  onSelectSeat,
  resaleSelectable = false,
}: {
  capacity: number;
  tickets: TicketState[];
  selectedSeat: number;
  onSelectSeat: (seat: number) => void;
  resaleSelectable?: boolean;
}) {
  const total = Math.max(1, Math.min(50, capacity || 2));
  const seats = Array.from({ length: total }, (_, idx) => {
    const num = idx + 1;
    const ticket = tickets.find((t) => t.slot === num);
    const booked = Boolean(ticket && ticket.owner && !/^0x0{40}$/i.test(ticket.owner));
    const listed = Boolean(ticket?.listed);
    return { num, booked, listed };
  });

  // Split seats into stadium rows (front row smaller, back rows wider)
  const rows: typeof seats[] = [];
  let cursor = 0;
  let rowSize = total <= 4 ? total : 4;
  while (cursor < seats.length) {
    rows.push(seats.slice(cursor, cursor + rowSize));
    cursor += rowSize;
    rowSize = Math.min(8, rowSize + 2);
  }

  return (
    <div className="stadium" aria-label="Stadium seating map">
      <div className="stadium-stage">STAGE</div>
      <div className="stadium-rows">
        {rows.map((row, rowIdx) => (
          <div key={rowIdx} className="stadium-row">
            <span className="stadium-row-label">R{rowIdx + 1}</span>
            <div className="stadium-seats">
              {row.map((seat) => {
                const isSelected = selectedSeat === seat.num;
                const disabled = seat.booked && !(resaleSelectable && seat.listed);
                const stateClass = seat.listed
                  ? 'resale'
                  : seat.booked
                    ? 'booked'
                    : isSelected
                      ? 'selected'
                      : 'available';
                return (
                  <button
                    key={seat.num}
                    type="button"
                    disabled={disabled}
                    className={`seat ${stateClass}`}
                    onClick={() => onSelectSeat(seat.num)}
                    title={
                      seat.listed
                        ? `Seat #${seat.num} · Listed for resale`
                        : seat.booked
                          ? `Seat #${seat.num} · Booked`
                          : `Seat #${seat.num} · Available`
                    }
                  >
                    S{seat.num}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="stadium-legend">
        <span><i className="dot available" /> Available</span>
        <span><i className="dot selected" /> Selected</span>
        <span><i className="dot booked" /> Booked</span>
        {seats.some((s) => s.listed) && (
          <span><i className="dot resale" /> Resale</span>
        )}
      </div>
    </div>
  );
}
