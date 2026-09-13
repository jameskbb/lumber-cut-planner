import matplotlib.pyplot as plt
import matplotlib.patches as patches

# Lumber represents an individual board or sheet used for cutting.
# Tracks remaining available spaces (rectangles) and used pieces.
class Lumber:
    def __init__(self, name, width, height):
        self.name = name  # identifier for the board
        self.width = width
        self.height = height
        self.remaining_rectangles = [(0, 0, width, height)]  # initially one large piece
        self.used_rectangles = []  # stores coordinates of each used piece
        self.bounds_box = (0, 0)  # visual bounding box over all cuts

    def area(self):
        return self.width * self.height

    # Checks if a piece of a given size can fit in any available rectangle
    def can_fit(self, piece_width, piece_height, kerf):
        for x, y, w, h in self.remaining_rectangles:
            if (piece_width + kerf <= w and piece_height + kerf <= h) or (piece_height + kerf <= w and piece_width + kerf <= h):
                return True
        return False

    # Attempts to cut up to max_quantity of a piece, arranging them in a grid to reduce waste
    def cut_piece(self, piece_width, piece_height, kerf, max_quantity=1):
        best_fit_idx = -1
        best_piece_coords = []
        best_layout_info = None

        # Loop through each open rectangle on the board
        for idx, (x, y, w, h) in enumerate(self.remaining_rectangles):
            for pw, ph in [(piece_width, piece_height), (piece_height, piece_width)]:
                cols = int((w + kerf) // (pw + kerf))
                rows = int((h + kerf) // (ph + kerf))
                count = min(cols * rows, max_quantity)
                if count == 0:
                    continue

                coords = []
                for r in range(rows):
                    for c in range(cols):
                        if len(coords) >= count:
                            break
                        px = x + c * (pw + kerf)
                        py = y + r * (ph + kerf)
                        if px + pw <= x + w and py + ph <= y + h:
                            coords.append((px, py, pw, ph))
                    if len(coords) >= count:
                        break

                if len(coords) > len(best_piece_coords):
                    best_fit_idx = idx
                    best_piece_coords = coords
                    best_layout_info = (x, y, pw, ph, cols, rows, w, h)

        if best_fit_idx >= 0 and best_piece_coords:
            try:
                rect_x, rect_y, rect_w, rect_h = self.remaining_rectangles[best_fit_idx]
                self.remaining_rectangles.pop(best_fit_idx)
            except IndexError:
                return False

            x, y, pw, ph, cols, rows, w, h = best_layout_info

            # Compute bounding box for the actual pieces we placed
            max_right = max((px + pw for px, _, pw, _ in best_piece_coords), default=x)
            max_bottom = max((py + ph for _, py, _, ph in best_piece_coords), default=y)
            total_width = max_right - x
            total_height = max_bottom - y

            for coord in best_piece_coords:
                self.used_rectangles.append(coord)

            # Slice remaining space into smaller rectangles
            new_rectangles = [
                (x + total_width + kerf, y, w - total_width - kerf, total_height),
                (x, y + total_height + kerf, w, h - total_height - kerf),
                (x + total_width + kerf, y + total_height + kerf, w - total_width - kerf, h - total_height - kerf)
            ]

            for rect in new_rectangles:
                if rect[2] > 0 and rect[3] > 0:
                    self.remaining_rectangles.append(rect)

            return True

        return False

# ProjectPlanner manages cut planning across all boards.
# Implements a greedy layout with logic prioritizing tight bounds and board reuse.
class ProjectPlanner:
    def __init__(self, lumber_list, blade_kerf=0.125, thickness=0.75):
        self.lumber = [Lumber(*item) for item in lumber_list]
        self.blade_kerf = blade_kerf
        self.thickness = thickness

    # Plan all cuts by sorting desired pieces and placing as many per board as possible
    def plan_cuts(self, pieces_needed):
        cuts_plan = []
        sorted_pieces = sorted(pieces_needed, key=lambda p: p[1] * p[2], reverse=True)

        for piece_name, piece_width, piece_height, qty in sorted_pieces:
            remaining = qty
            while remaining > 0:
                # Prioritize boards that:
                # 1. Minimize the bounding box size used so far (tightest fit)
                # 2. Have smallest total remaining space
                # 3. Already have cuts to increase consolidation
                usable_boards = sorted(
                    filter(lambda b: b.can_fit(piece_width, piece_height, self.blade_kerf), self.lumber),
                    key=lambda b: (
                        (max((r[0] + r[2]) for r in b.used_rectangles) if b.used_rectangles else 0) *
                        (max((r[1] + r[3]) for r in b.used_rectangles) if b.used_rectangles else 0),
                        sum(w * h for _, _, w, h in b.remaining_rectangles),
                        -len(b.used_rectangles)
                    )
                )
                cut_made = False
                for board in usable_boards:
                    if board.cut_piece(piece_width, piece_height, self.blade_kerf, remaining):
                        # Count how many new pieces were added for this board
                        cut_count = len(board.used_rectangles) - len([c for c in cuts_plan if self.lumber.index(board) == c[3]])
                        for _ in range(cut_count):
                            cuts_plan.append((piece_name, piece_width, piece_height, self.lumber.index(board)))
                        remaining -= cut_count
                        cut_made = True
                        break
                if not cut_made:
                    return False, []
        return True, cuts_plan

    # Displays the cut layout using matplotlib for each board
    def visualize(self):
        fig, axs = plt.subplots(len(self.lumber), figsize=(10, 5 * len(self.lumber)))
        fig.canvas.manager.set_window_title('Lumber Cut Planner')
        if len(self.lumber) == 1:
            axs = [axs]

        for idx, lumber in enumerate(self.lumber):
            axs[idx].set_title(f'Lumber "{lumber.name}" Layout ({lumber.width}" x {lumber.height}")')
            axs[idx].set_xlim(0, lumber.width)
            axs[idx].set_ylim(0, lumber.height)
            axs[idx].set_aspect('equal')

            legend_labels = []

            if lumber.used_rectangles:
                max_x = max((rect[0] + rect[2]) for rect in lumber.used_rectangles)
                max_y = max((rect[1] + rect[3]) for rect in lumber.used_rectangles)
                lumber.bounds_box = (max_x, max_y)

                bounds = patches.Rectangle(
                    (0, 0), max_x, max_y,
                    edgecolor='green', facecolor='lightgreen', alpha=0.3,
                    label=f'Bounds Box (total cut area): {max_x}" x {max_y}"'
                )
                axs[idx].add_patch(bounds)
                legend_labels.append(bounds)

            for rect in lumber.used_rectangles:
                piece = patches.Rectangle((rect[0], rect[1]), rect[2], rect[3], edgecolor='blue', facecolor='lightblue', label='Used Piece')
                axs[idx].add_patch(piece)
                axs[idx].text(rect[0] + rect[2]/2, rect[1] + rect[3]/2, f'{rect[2]}"x{rect[3]}"', va='center', ha='center')
                if 'Used Piece' not in [lbl.get_label() for lbl in legend_labels]:
                    legend_labels.append(piece)

            for rect in lumber.remaining_rectangles:
                rem = patches.Rectangle((rect[0], rect[1]), rect[2], rect[3], edgecolor='red', linestyle='--', fill=False, label='Remaining Area')
                axs[idx].add_patch(rem)
                if 'Remaining Area' not in [lbl.get_label() for lbl in legend_labels]:
                    legend_labels.append(rem)

            axs[idx].legend(handles=legend_labels, loc='upper left', bbox_to_anchor=(1, 1))

        plt.tight_layout()
        plt.show()

# Demonstration mode (default)
def run_demo():
    source_boards = [("Large Board", 48, 96), ("Small Board", 24, 48)]
    final_parts = [("Side", 12, 24, 2), ("Back", 12, 24, 1), ("Top", 12, 12, 1), ("Bottom", 12, 12, 1)]
    run_project(source_boards, final_parts, 0.125)

# Entry point for planning based on user or demo input
def run_project(source_boards, final_parts, kerf):
    planner = ProjectPlanner(source_boards, kerf)
    success, cuts_plan = planner.plan_cuts(final_parts)

    if success:
        planner.visualize()
    else:
        print("\n[ERROR] Insufficient lumber to complete the project.")

if __name__ == '__main__':
    mode = "demo"  # Change this to 'interactive' for user-driven input

    if mode == "interactive":
        source_boards = []
        print("\n--- Enter Source Material (Boards Available) ---")
        while True:
            name = input("Enter source lumber name (or 'done'): ")
            if name.lower() == 'done': break
            width = float(input("Width (inches): "))
            height = float(input("Height (inches): "))
            qty = int(input("Quantity of this lumber: "))
            for _ in range(qty):
                source_boards.append((name, width, height))

        final_parts = []
        print("\n--- Enter Desired Final Pieces ---")
        while True:
            name = input("Enter final piece name (or 'done'): ")
            if name.lower() == 'done': break
            width = float(input("Width (inches): "))
            height = float(input("Height (inches): "))
            qty = int(input("Quantity needed: "))
            final_parts.append((name, width, height, qty))

        kerf_override = input("Keep blade kerf (width of blade) at 0.125 inch default? (y/n): ")
        kerf = float(input("Enter blade kerf in inches: ")) if kerf_override.lower() == 'n' else 0.125

        run_project(source_boards, final_parts, kerf)
    else:
        run_demo()
