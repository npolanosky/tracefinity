"""Tests for per-tool spacing override resolution and the bin tool_spacing field."""
import pytest
from pydantic import ValidationError

from app.models.schemas import BinParams, Tool, Point
from app.services.bin_service import resolve_spacing


def make_tool(spacing_override=None):
    return Tool(
        id="t1",
        name="test",
        points=[Point(x=0, y=0), Point(x=10, y=0), Point(x=10, y=10), Point(x=0, y=10)],
        spacing_override=spacing_override,
    )


class TestResolveSpacing:
    def test_no_tool_uses_bin_default(self):
        assert resolve_spacing(None, 2.0) == 2.0

    def test_no_override_uses_bin_default(self):
        assert resolve_spacing(make_tool(), 2.0) == 2.0

    def test_override_takes_precedence(self):
        assert resolve_spacing(make_tool(spacing_override=3.25), 0.0) == 3.25

    def test_zero_override_means_no_extra_keepout(self):
        assert resolve_spacing(make_tool(spacing_override=0.0), 2.0) == 0.0


class TestToolSpacingValidator:
    def test_defaults_to_zero(self):
        assert BinParams().tool_spacing == 0.0

    def test_accepts_bounds(self):
        assert BinParams(tool_spacing=0.0).tool_spacing == 0.0
        assert BinParams(tool_spacing=20.0).tool_spacing == 20.0

    def test_rejects_negative(self):
        with pytest.raises(ValidationError):
            BinParams(tool_spacing=-1.0)

    def test_rejects_too_large(self):
        with pytest.raises(ValidationError):
            BinParams(tool_spacing=21.0)


class TestSpacingRoundTrip:
    def test_override_survives_dump_and_validate(self):
        tool = make_tool(spacing_override=3.25)
        loaded = Tool.model_validate(tool.model_dump())
        assert loaded.spacing_override == 3.25

    def test_missing_key_defaults_to_none(self):
        """tools.json written before the field existed must load unchanged"""
        data = make_tool().model_dump()
        del data["spacing_override"]
        assert Tool.model_validate(data).spacing_override is None

    def test_bin_params_missing_key_defaults_to_zero(self):
        data = BinParams().model_dump()
        del data["tool_spacing"]
        assert BinParams.model_validate(data).tool_spacing == 0.0
