from datetime import datetime, timedelta
from time import monotonic

START_TIME = datetime(2018, 11, 8, 11, 0, 0)


class SimulatedClock:
    """Clock that resets on process start and advances one minute per real minute."""

    def __init__(self, start_time: datetime = START_TIME) -> None:
        self.start_time = start_time
        self.started_at = monotonic()

    def now(self) -> datetime:
        elapsed_minutes = int((monotonic() - self.started_at) // 60)
        return self.start_time + timedelta(minutes=elapsed_minutes)

    def isoformat(self) -> str:
        return self.now().isoformat(timespec="seconds")


clock = SimulatedClock()
